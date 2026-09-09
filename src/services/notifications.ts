import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { BookingRow } from '../domain/booking.js';
import { loadRefOptions, type RefOption } from '../domain/refOptions.js';
import { emailTransport } from './email/index.js';
import {
  newBookingEmail,
  newBookingAlertEmail,
  customerAcknowledgementEmail,
  bookingConfirmedEmail,
  bookingBookedEmail,
  bookingCancelledEmail,
  bookingUpdatedEmail,
  staffMessageEmail,
  type EmailContent,
} from './email/templates/index.js';
import { whatsAppProvider } from './whatsapp/index.js';
import { newBookingWhatsApp } from './whatsapp/messages.js';
import { spreadsheetProvider } from './spreadsheet/index.js';
import * as notificationsRepo from '../repositories/notifications.js';
import { markCommunication } from '../repositories/bookings.js';
import { normalisePhone } from '../utils/phone.js';

/**
 * Fan-out of a booking to every downstream channel.
 *
 * The contract this module exists to uphold: **a channel failure must never
 * affect the booking, or any other channel**. Every send is wrapped, every
 * outcome is written to notification_logs, and nothing here throws.
 */

export type Channel = 'EMAIL' | 'WHATSAPP' | 'SPREADSHEET';

export interface ChannelOutcome {
  channel: Channel;
  kind: string;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  error?: string;
  messageId?: string;
}

export interface DispatchResult {
  outcomes: ChannelOutcome[];
}

async function refs(): Promise<Map<string, RefOption[]>> {
  return loadRefOptions();
}

/** Runs one channel, converting any throw into a recorded FAILED outcome. */
async function guard(
  bookingId: string | null,
  channel: Channel,
  kind: string,
  recipient: string | null,
  run: () => Promise<{ ok: boolean; skipped?: boolean; messageId?: string; error?: string }>,
): Promise<ChannelOutcome> {
  let result: { ok: boolean; skipped?: boolean; messageId?: string; error?: string };
  try {
    result = await run();
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const status: ChannelOutcome['status'] = result.ok ? 'SENT' : result.skipped ? 'SKIPPED' : 'FAILED';

  try {
    await notificationsRepo.logNotification({
      bookingId,
      channel,
      kind,
      status,
      recipient,
      providerMessageId: result.messageId ?? null,
      errorMessage: result.error ?? null,
    });
  } catch (err) {
    // Logging the outcome must never itself break the dispatch.
    logger.error({ err, channel, kind }, 'Failed to write notification log');
  }

  if (status === 'FAILED') {
    logger.warn({ bookingId, channel, kind, error: result.error }, 'Notification channel failed');
  }

  return { channel, kind, status, error: result.error, messageId: result.messageId };
}

async function sendEmail(
  booking: BookingRow | null,
  to: string,
  content: EmailContent,
  template: string,
  sentBy: string | null = null,
  replyTo?: string,
): Promise<{ ok: boolean; skipped?: boolean; messageId?: string; error?: string }> {
  // Customer-facing mail replies to the inbox CHFR works from, never to the
  // verified-domain From address, which is usually not a real mailbox.
  const result = await emailTransport().send(to, content, replyTo ?? config.replyTo);
  try {
    await notificationsRepo.logEmail({
      bookingId: booking?.id ?? null,
      template,
      recipient: to,
      subject: content.subject,
      status: result.ok ? (result.skipped ? 'SKIPPED' : 'SENT') : 'FAILED',
      providerMessageId: result.messageId ?? null,
      errorMessage: result.error ?? null,
      sentBy,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to write email log');
  }
  return result;
}

// ------------------------------------------------------- new booking fan-out

export async function dispatchNewBooking(booking: BookingRow): Promise<DispatchResult> {
  const refMap = await refs();
  const appUrl = config.APP_URL;

  // All three channels run concurrently and independently. `allSettled` plus
  // the per-channel guard means one rejection cannot cancel the others.
  const [internalEmail, alertEmail, customerEmail, sheet, whatsapp] = await Promise.all([
    guard(booking.id, 'EMAIL', 'INTERNAL_NEW_BOOKING', config.ADMIN_EMAIL, () =>
      sendEmail(
        booking,
        config.ADMIN_EMAIL,
        newBookingEmail({ booking, refs: refMap, appUrl }),
        'newBooking',
        null,
        booking.email, // replying to the alert reaches the customer
      ),
    ),

    guard(booking.id, 'EMAIL', 'ALERT_NEW_BOOKING', alertRecipient(), () => sendAlertEmail(booking, refMap, appUrl)),

    guard(booking.id, 'EMAIL', 'CUSTOMER_ACK', booking.email, () =>
      sendEmail(
        booking,
        booking.email,
        customerAcknowledgementEmail({ booking, refs: refMap, appUrl }),
        'customerAcknowledgement',
      ),
    ),

    guard(booking.id, 'SPREADSHEET', 'BOOKING_ROW', null, async () => {
      const res = await spreadsheetProvider().upsertBooking(booking, refMap);
      if (res.ok) {
        await markCommunication(booking.id, {
          sheet_row_number: res.rowNumber ?? null,
          sheet_synced_at: new Date().toISOString(),
          sheet_status: 'SYNCED',
        });
      } else {
        await markCommunication(booking.id, { sheet_status: res.skipped ? 'SKIPPED' : 'FAILED' });
      }
      return res;
    }),

    guard(booking.id, 'WHATSAPP', 'INTERNAL_NEW_BOOKING', config.CHFR_WHATSAPP_NUMBER ?? null, () =>
      sendBusinessWhatsApp(booking, newBookingWhatsApp(booking, refMap, appUrl)),
    ),
  ]);

  // Reflect delivery state on the booking so the dashboard can show it at a glance.
  await markCommunication(booking.id, {
    internal_email_sent: internalEmail.status === 'SENT',
    customer_email_sent: customerEmail.status === 'SENT',
    whatsapp_sent: whatsapp.status === 'SENT',
    whatsapp_status: whatsapp.status === 'SENT' ? 'SENT' : whatsapp.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
    whatsapp_message_id: whatsapp.messageId ?? null,
  }).catch((err) => logger.error({ err }, 'Failed to record communication flags'));

  return { outcomes: [internalEmail, alertEmail, customerEmail, sheet, whatsapp] };
}

/**
 * The short new-booking ping. Skipped when unset, and when it points at
 * ADMIN_EMAIL, which already receives the full internal email.
 */
function alertRecipient(): string | null {
  const alert = config.ALERT_EMAIL?.trim();
  if (!alert) return null;
  if (alert.toLowerCase() === config.ADMIN_EMAIL.trim().toLowerCase()) return null;
  return alert;
}

async function sendAlertEmail(
  booking: BookingRow,
  refMap: Map<string, RefOption[]>,
  appUrl: string,
): Promise<{ ok: boolean; skipped?: boolean; messageId?: string; error?: string }> {
  const to = alertRecipient();
  if (!to) {
    return { ok: false, skipped: true, error: 'ALERT_EMAIL is unset or matches ADMIN_EMAIL' };
  }
  return sendEmail(
    booking,
    to,
    newBookingAlertEmail({ booking, refs: refMap, appUrl }),
    'newBookingAlert',
    null,
    booking.email,
  );
}

/** Sends to the configured CHFR business number, validating it first. */
async function sendBusinessWhatsApp(
  booking: BookingRow,
  body: string,
): Promise<{ ok: boolean; skipped?: boolean; messageId?: string; error?: string }> {
  const provider = whatsAppProvider();
  if (!provider.configured) {
    return { ok: false, skipped: true, error: 'WhatsApp is not configured' };
  }

  const to = normalisePhone(config.CHFR_WHATSAPP_NUMBER ?? '');
  if (!to) {
    return { ok: false, error: 'CHFR_WHATSAPP_NUMBER is missing or not a valid international number' };
  }

  const result = await provider.sendText(to, body);
  await notificationsRepo
    .logWhatsApp({
      bookingId: booking.id,
      recipient: to,
      body,
      status: result.ok ? 'SENT' : result.skipped ? 'SKIPPED' : 'FAILED',
      provider: provider.name,
      providerMessageId: result.messageId ?? null,
      errorMessage: result.error ?? null,
    })
    .catch((err) => logger.error({ err }, 'Failed to write WhatsApp log'));

  return result;
}

// ------------------------------------------------------------------- retries

export async function retryInternalEmail(booking: BookingRow): Promise<ChannelOutcome> {
  const refMap = await refs();
  const outcome = await guard(booking.id, 'EMAIL', 'INTERNAL_NEW_BOOKING', config.ADMIN_EMAIL, () =>
    sendEmail(
      booking,
      config.ADMIN_EMAIL,
      newBookingEmail({ booking, refs: refMap, appUrl: config.APP_URL }),
      'newBooking',
      null,
      booking.email,
    ),
  );
  await markCommunication(booking.id, { internal_email_sent: outcome.status === 'SENT' });
  return outcome;
}

export async function retryCustomerAck(booking: BookingRow): Promise<ChannelOutcome> {
  const refMap = await refs();
  const outcome = await guard(booking.id, 'EMAIL', 'CUSTOMER_ACK', booking.email, () =>
    sendEmail(
      booking,
      booking.email,
      customerAcknowledgementEmail({ booking, refs: refMap, appUrl: config.APP_URL }),
      'customerAcknowledgement',
    ),
  );
  await markCommunication(booking.id, { customer_email_sent: outcome.status === 'SENT' });
  return outcome;
}

export async function retryWhatsApp(booking: BookingRow): Promise<ChannelOutcome> {
  const refMap = await refs();
  const outcome = await guard(booking.id, 'WHATSAPP', 'INTERNAL_NEW_BOOKING', config.CHFR_WHATSAPP_NUMBER ?? null, () =>
    sendBusinessWhatsApp(booking, newBookingWhatsApp(booking, refMap, config.APP_URL)),
  );
  await markCommunication(booking.id, {
    whatsapp_sent: outcome.status === 'SENT',
    whatsapp_status: outcome.status === 'SENT' ? 'SENT' : outcome.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
    whatsapp_message_id: outcome.messageId ?? null,
  });
  return outcome;
}

export async function syncSpreadsheet(booking: BookingRow): Promise<ChannelOutcome> {
  const refMap = await refs();
  return guard(booking.id, 'SPREADSHEET', 'BOOKING_ROW', null, async () => {
    const res = await spreadsheetProvider().upsertBooking(booking, refMap);
    await markCommunication(booking.id, {
      sheet_row_number: res.rowNumber ?? null,
      sheet_synced_at: res.ok ? new Date().toISOString() : null,
      sheet_status: res.ok ? 'SYNCED' : res.skipped ? 'SKIPPED' : 'FAILED',
    });
    return res;
  });
}

// ------------------------------------------------ customer-facing updates

export type CustomerUpdateKind = 'CONFIRMED' | 'CANCELLED' | 'UPDATED';

export async function sendCustomerUpdate(
  booking: BookingRow,
  kind: CustomerUpdateKind,
  changes: Array<{ label: string; from: string; to: string }>,
  sentBy: string | null,
): Promise<ChannelOutcome> {
  const refMap = await refs();
  const ctx = { booking, refs: refMap, appUrl: config.APP_URL };

  const content =
    kind === 'CONFIRMED'
      ? bookingConfirmedEmail(ctx)
      : kind === 'CANCELLED'
        ? bookingCancelledEmail(ctx)
        : bookingUpdatedEmail({ ...ctx, changes });

  const template =
    kind === 'CONFIRMED' ? 'bookingConfirmed' : kind === 'CANCELLED' ? 'bookingCancelled' : 'bookingUpdated';

  const outcome = await guard(booking.id, 'EMAIL', `CUSTOMER_${kind}`, booking.email, () =>
    sendEmail(booking, booking.email, content, template, sentBy),
  );

  if (outcome.status === 'SENT') {
    await markCommunication(booking.id, { last_contacted_at: new Date().toISOString() });
  }
  return outcome;
}

/**
 * The short "you are booked" email, sent from its own button. Kept separate
 * from sendCustomerUpdate because it is not a diff of what changed, it is a
 * standalone reassurance with the current details.
 */
export async function sendBookedConfirmation(
  booking: BookingRow,
  sentBy: string | null,
): Promise<ChannelOutcome> {
  const refMap = await refs();
  const content = bookingBookedEmail({ booking, refs: refMap, appUrl: config.APP_URL });

  const outcome = await guard(booking.id, 'EMAIL', 'CUSTOMER_BOOKED', booking.email, () =>
    sendEmail(booking, booking.email, content, 'bookingBooked', sentBy),
  );

  if (outcome.status === 'SENT') {
    await markCommunication(booking.id, {
      customer_email_sent: true,
      last_contacted_at: new Date().toISOString(),
    });
  }
  return outcome;
}

/** Free-text email composed by staff on the booking detail page. */
export async function sendStaffEmail(
  booking: BookingRow,
  subject: string,
  message: string,
  sentBy: string | null,
): Promise<ChannelOutcome> {
  const refMap = await refs();
  const content = staffMessageEmail({
    booking,
    refs: refMap,
    appUrl: config.APP_URL,
    subject,
    message,
  });

  const outcome = await guard(booking.id, 'EMAIL', 'STAFF_MESSAGE', booking.email, () =>
    sendEmail(booking, booking.email, content, 'staffMessage', sentBy),
  );

  if (outcome.status === 'SENT') {
    await markCommunication(booking.id, { last_contacted_at: new Date().toISOString() });
  }
  return outcome;
}

/** Free-text WhatsApp composed by staff, sent to the customer. */
export async function sendCustomerWhatsApp(
  booking: BookingRow,
  message: string,
  sentBy: string | null,
): Promise<ChannelOutcome> {
  const provider = whatsAppProvider();

  const outcome = await guard(booking.id, 'WHATSAPP', 'STAFF_MESSAGE', booking.mobile, async () => {
    if (!provider.configured) return { ok: false, skipped: true, error: 'WhatsApp is not configured' };

    const to = normalisePhone(booking.mobile);
    if (!to) return { ok: false, error: 'Customer mobile is not a valid international number' };

    const result = await provider.sendText(to, message);
    await notificationsRepo
      .logWhatsApp({
        bookingId: booking.id,
        recipient: to,
        body: message,
        status: result.ok ? 'SENT' : result.skipped ? 'SKIPPED' : 'FAILED',
        provider: provider.name,
        providerMessageId: result.messageId ?? null,
        errorMessage: result.error ?? null,
        sentBy,
      })
      .catch((err) => logger.error({ err }, 'Failed to write WhatsApp log'));
    return result;
  });

  if (outcome.status === 'SENT') {
    await markCommunication(booking.id, { last_contacted_at: new Date().toISOString() });
  }
  return outcome;
}
