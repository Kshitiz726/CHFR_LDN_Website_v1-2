import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { logger } from '../utils/logger.js';
import type { BookingRow } from '../domain/booking.js';
import { EDITABLE_FIELDS, CUSTOMER_IMPACTING_FIELDS } from '../domain/booking.js';
import { loadRefOptions, labelFromMap } from '../domain/refOptions.js';
import { nextBookingReference } from '../domain/reference.js';
import { bookingDedupeHash } from '../utils/crypto.js';
import * as repo from '../repositories/bookings.js';
import type { ValidatedBooking } from '../validation/booking.js';
import {
  dispatchNewBooking, sendCustomerUpdate, syncSpreadsheet, retryCustomerAck,
  type DispatchResult,
} from './notifications.js';

/** How long an identical journey from the same customer counts as a re-submit. */
const DUPLICATE_WINDOW_MINUTES = 15;

export interface CreateBookingContext {
  idempotencyKey?: string;
  source?: string;
  userAgent?: string | null;
  ipHash?: string | null;
}

export interface CreateBookingResult {
  booking: BookingRow;
  /** True when this request matched an existing booking rather than creating one. */
  duplicate: boolean;
  /** Resolves when every notification channel has finished. Never rejects. */
  dispatch: Promise<DispatchResult>;
}

/**
 * Creates a booking.
 *
 * The database write is the only step that can fail the request. Notifications
 * are dispatched afterwards and their failures are recorded, never propagated —
 * a booking is never lost because SMTP, Sheets or WhatsApp was unavailable.
 */
export async function createBooking(
  input: ValidatedBooking,
  ctx: CreateBookingContext = {},
): Promise<CreateBookingResult> {
  const dedupeHash = bookingDedupeHash(input);

  // Guard 1 — an explicit idempotency key from the browser.
  if (ctx.idempotencyKey) {
    const existing = await repo.findByIdempotencyKey(ctx.idempotencyKey);
    if (existing) {
      logger.info({ reference: existing.booking_reference }, 'Idempotent replay — returning existing booking');
      return { booking: existing, duplicate: true, dispatch: resendAcknowledgement(existing) };
    }
  }

  // Guard 2 — the same journey submitted again moments later (refresh, retry).
  const recent = await repo.findRecentDuplicate(dedupeHash, DUPLICATE_WINDOW_MINUTES);
  if (recent) {
    logger.info({ reference: recent.booking_reference }, 'Duplicate journey within window — returning existing booking');
    if (ctx.idempotencyKey) {
      await db()
        .transaction((tx) => repo.recordIdempotencyKey(tx, ctx.idempotencyKey!, recent.id))
        .catch(() => undefined);
    }
    return { booking: recent, duplicate: true, dispatch: resendAcknowledgement(recent) };
  }

  const booking = await db().transaction(async (tx) => {
    const reference = await nextBookingReference(tx);
    const created = await repo.insertBooking(tx, {
      ...input,
      booking_reference: reference,
      currency: config.DEFAULT_CURRENCY,
      source: ctx.source ?? 'WEBSITE',
      user_agent: ctx.userAgent ? ctx.userAgent.slice(0, 400) : null,
      ip_hash: ctx.ipHash ?? null,
      dedupe_hash: dedupeHash,
    });

    await repo.appendEvent(tx, created.id, {
      event_type: 'BOOKING_CREATED',
      message: `Booking created from ${created.source === 'WEBSITE' ? 'the website' : created.source}`,
      changed_by_label: 'System',
    });

    if (ctx.idempotencyKey) {
      await repo.recordIdempotencyKey(tx, ctx.idempotencyKey, created.id);
    }
    return created;
  });

  logger.info({ reference: booking.booking_reference, id: booking.id }, 'Booking created');

  // Started here, deliberately not awaited by the caller's critical path.
  const dispatch = dispatchNewBooking(booking).catch((err) => {
    logger.error({ err, id: booking.id }, 'Notification dispatch threw unexpectedly');
    return { outcomes: [] } as DispatchResult;
  });

  return { booking, duplicate: false, dispatch };
}


/**
 * A customer who submits the same journey twice has usually not seen the first
 * acknowledgement — it was slow, or it went to spam. Re-sending it is the
 * helpful response. The internal alert and the spreadsheet are deliberately
 * NOT repeated: staff should see one booking, not two.
 */
async function resendAcknowledgement(booking: BookingRow): Promise<DispatchResult> {
  try {
    const outcome = await retryCustomerAck(booking);
    return { outcomes: [outcome] };
  } catch (err) {
    logger.error({ err, id: booking.id }, 'Could not re-send acknowledgement for a duplicate submission');
    return { outcomes: [] };
  }
}

export interface ActorContext {
  userId: string | null;
  label: string;
  role?: 'ADMIN' | 'STAFF';
}

export interface UpdateResult {
  booking: BookingRow;
  changes: Array<{ field: string; label: string; from: string; to: string }>;
  customerNotification?: { attempted: boolean; sent: boolean; error?: string };
}

/**
 * Applies a staff edit, writing one audit event per changed field and
 * optionally notifying the customer when a customer-impacting field changed.
 */
export async function updateBooking(
  id: string,
  patch: Record<string, unknown>,
  actor: ActorContext,
  options: { notifyCustomer?: boolean } = {},
): Promise<UpdateResult | null> {
  const before = await repo.findById(id);
  if (!before) return null;

  const refs = await loadRefOptions();

  // Only fields whose value actually differs are written or logged, so the
  // audit trail stays a record of real changes rather than form submissions.
  const effective: Record<string, unknown> = {};
  const changes: UpdateResult['changes'] = [];

  for (const [field, nextValue] of Object.entries(patch)) {
    if (!(field in EDITABLE_FIELDS)) continue;
    const currentValue = (before as unknown as Record<string, unknown>)[field] ?? null;
    if (sameValue(currentValue, nextValue)) continue;

    effective[field] = nextValue;
    changes.push({
      field,
      label: EDITABLE_FIELDS[field]!,
      from: displayValue(field, currentValue, refs, before.currency),
      to: displayValue(field, nextValue, refs, before.currency),
    });
  }

  if (changes.length === 0) {
    return { booking: before, changes: [] };
  }

  const after = await db().transaction(async (tx) => {
    const updated = await repo.updateBookingFields(tx, id, effective);

    for (const change of changes) {
      await repo.appendEvent(tx, id, {
        event_type: change.field === 'status' ? 'STATUS_CHANGED' : 'FIELD_CHANGED',
        field: change.field,
        old_value: change.from,
        new_value: change.to,
        message: `${change.label} changed`,
        changed_by: actor.userId,
        changed_by_label: actor.label,
      });
    }
    return updated!;
  });

  logger.info({ id, fields: changes.map((c) => c.field), by: actor.label }, 'Booking updated');

  // The spreadsheet is a projection: re-push the row so it matches the DB.
  syncSpreadsheet(after).catch((err) => logger.error({ err, id }, 'Spreadsheet resync failed'));

  const result: UpdateResult = { booking: after, changes };

  // Customer email only for changes the customer actually needs to know about,
  // and only when staff asked for it (or the booking became confirmed/cancelled).
  const impacting = changes.filter((c) => CUSTOMER_IMPACTING_FIELDS.has(c.field));
  const becameConfirmed = changes.some((c) => c.field === 'status' && after.status === 'CONFIRMED');
  const becameCancelled = changes.some((c) => c.field === 'status' && after.status === 'CANCELLED');

  if (config.CUSTOMER_UPDATE_EMAILS_ENABLED && options.notifyCustomer && impacting.length > 0) {
    const kind = becameConfirmed ? 'CONFIRMED' : becameCancelled ? 'CANCELLED' : 'UPDATED';
    const outcome = await sendCustomerUpdate(after, kind, impacting, actor.userId);
    result.customerNotification = {
      attempted: true,
      sent: outcome.status === 'SENT',
      error: outcome.error,
    };

    await db()
      .transaction((tx) =>
        repo.appendEvent(tx, id, {
          event_type: 'CUSTOMER_NOTIFIED',
          message: `Customer update email (${kind}) ${outcome.status === 'SENT' ? 'sent' : `not sent — ${outcome.status}`}`,
          changed_by: actor.userId,
          changed_by_label: actor.label,
        }),
      )
      .catch((err) => logger.error({ err }, 'Failed to log customer notification event'));
  }

  return result;
}

/** Records a free-text internal note as an audit event. */
export async function addNote(id: string, note: string, actor: ActorContext): Promise<boolean> {
  const booking = await repo.findById(id);
  if (!booking) return false;

  await db().transaction((tx) =>
    repo.appendEvent(tx, id, {
      event_type: 'NOTE_ADDED',
      message: note,
      changed_by: actor.userId,
      changed_by_label: actor.label,
    }),
  );
  return true;
}

/** Stamps last_contacted_at and records who marked it. */
export async function markContacted(id: string, actor: ActorContext): Promise<BookingRow | null> {
  const booking = await repo.findById(id);
  if (!booking) return null;

  await db().transaction(async (tx) => {
    await repo.updateBookingFields(tx, id, { last_contacted_at: new Date().toISOString() });
    await repo.appendEvent(tx, id, {
      event_type: 'MARKED_CONTACTED',
      message: 'Marked as contacted',
      changed_by: actor.userId,
      changed_by_label: actor.label,
    });
  });

  return repo.findById(id);
}

export async function archiveBooking(id: string, actor: ActorContext): Promise<boolean> {
  const booking = await repo.findById(id);
  if (!booking) return false;

  await db().transaction(async (tx) => {
    await repo.archiveBooking(tx, id, actor.userId ?? '0');
    await repo.appendEvent(tx, id, {
      event_type: 'ARCHIVED',
      message: 'Booking archived',
      changed_by: actor.userId,
      changed_by_label: actor.label,
    });
  });
  return true;
}

export async function restoreBooking(id: string, actor: ActorContext): Promise<boolean> {
  const booking = await repo.findById(id);
  if (!booking) return false;

  await db().transaction(async (tx) => {
    await repo.restoreBooking(tx, id);
    await repo.appendEvent(tx, id, {
      event_type: 'RESTORED',
      message: 'Booking restored from archive',
      changed_by: actor.userId,
      changed_by_label: actor.label,
    });
  });
  return true;
}

/** Permanent deletion. Callers must have already checked the ADMIN role. */
export async function purgeBooking(id: string, actor: ActorContext): Promise<boolean> {
  const booking = await repo.findById(id);
  if (!booking) return false;

  await db().transaction((tx) => repo.hardDeleteBooking(tx, id));
  logger.warn(
    { reference: booking.booking_reference, by: actor.label },
    'Booking permanently deleted (GDPR erasure or admin purge)',
  );
  return true;
}

// ------------------------------------------------------------------ helpers

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null && (b === null || b === undefined)) return true;
  if (a === undefined && b === null) return true;
  // Prices arrive as numbers but may be compared against numeric strings.
  if (typeof a === 'number' || typeof b === 'number') {
    const na = a === null || a === undefined ? NaN : Number(a);
    const nb = b === null || b === undefined ? NaN : Number(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return true;
    return na === nb;
  }
  return String(a ?? '') === String(b ?? '');
}

/** Renders a stored value the way it appears in the audit trail and emails. */
function displayValue(
  field: string,
  value: unknown,
  refs: Map<string, ReturnType<typeof labelFromMap> extends string ? never : never> | Map<string, any>,
  currency: string,
): string {
  if (value === null || value === undefined || value === '') return '—';

  const categories: Record<string, 'status' | 'priority' | 'payment_status' | 'journey_type' | 'vehicle' | 'luggage'> = {
    status: 'status',
    priority: 'priority',
    payment_status: 'payment_status',
    journey_type: 'journey_type',
    preferred_vehicle: 'vehicle',
    luggage: 'luggage',
  };

  const category = categories[field];
  if (category) return labelFromMap(refs as Map<string, any>, category, String(value));

  if (field === 'quoted_price' || field === 'confirmed_price') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(n);
      } catch {
        return `${currency} ${n.toFixed(2)}`;
      }
    }
  }

  const s = String(value);
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

export { repo as bookingsRepo };
