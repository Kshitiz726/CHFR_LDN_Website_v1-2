import { db, type Queryable } from '../db/index.js';

export type NotificationChannel = 'EMAIL' | 'WHATSAPP' | 'SPREADSHEET';
export type NotificationStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface NotificationLogRow {
  id: string;
  booking_id: string | null;
  booking_reference?: string;
  channel: NotificationChannel;
  kind: string;
  status: NotificationStatus;
  recipient: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  sent_at: string | null;
}

/**
 * One row per delivery attempt outcome, keyed by (booking, channel, kind) so a
 * retry updates the existing record rather than piling up duplicates.
 */
export async function logNotification(
  entry: {
    bookingId: string | null;
    channel: NotificationChannel;
    kind: string;
    status: NotificationStatus;
    recipient?: string | null;
    providerMessageId?: string | null;
    errorMessage?: string | null;
  },
  q: Queryable = db(),
): Promise<void> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT id::text AS id FROM notification_logs
      WHERE booking_id IS NOT DISTINCT FROM $1 AND channel = $2 AND kind = $3
      ORDER BY created_at DESC LIMIT 1`,
    [entry.bookingId, entry.channel, entry.kind],
  );

  const existing = rows[0]?.id;
  // Error text is truncated: enough to diagnose, short enough that a provider
  // stack trace can never fill the table.
  const error = entry.errorMessage ? entry.errorMessage.slice(0, 500) : null;

  if (existing) {
    await q.query(
      `UPDATE notification_logs
          SET status = $2, recipient = $3, provider_message_id = $4,
              error_message = $5, attempts = attempts + 1,
              sent_at = CASE WHEN $2 = 'SENT' THEN now() ELSE sent_at END
        WHERE id = $1`,
      [existing, entry.status, entry.recipient ?? null, entry.providerMessageId ?? null, error],
    );
    return;
  }

  await q.query(
    `INSERT INTO notification_logs
       (booking_id, channel, kind, status, recipient, provider_message_id, error_message, attempts, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1, CASE WHEN $4 = 'SENT' THEN now() ELSE NULL END)`,
    [entry.bookingId, entry.channel, entry.kind, entry.status, entry.recipient ?? null, entry.providerMessageId ?? null, error],
  );
}

export async function listNotifications(bookingId: string, q: Queryable = db()): Promise<NotificationLogRow[]> {
  const { rows } = await q.query<NotificationLogRow>(
    `SELECT id::text AS id, booking_id::text AS booking_id, channel, kind, status,
            recipient, provider_message_id, error_message, attempts, created_at, sent_at
       FROM notification_logs WHERE booking_id = $1 ORDER BY created_at DESC`,
    [bookingId],
  );
  return rows;
}

export async function listFailedNotifications(limit = 50, q: Queryable = db()): Promise<NotificationLogRow[]> {
  const { rows } = await q.query<NotificationLogRow>(
    `SELECT n.id::text AS id, n.booking_id::text AS booking_id, b.booking_reference,
            n.channel, n.kind, n.status, n.recipient, n.provider_message_id,
            n.error_message, n.attempts, n.created_at, n.sent_at
       FROM notification_logs n
       LEFT JOIN bookings b ON b.id = n.booking_id
      WHERE n.status = 'FAILED'
      ORDER BY n.created_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 200)}`,
  );
  return rows;
}

export async function logEmail(
  entry: {
    bookingId: string | null;
    template: string;
    recipient: string;
    subject: string;
    status: NotificationStatus;
    providerMessageId?: string | null;
    errorMessage?: string | null;
    sentBy?: string | null;
  },
  q: Queryable = db(),
): Promise<void> {
  await q.query(
    `INSERT INTO email_logs (booking_id, template, recipient, subject, status, provider_message_id, error_message, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.bookingId, entry.template, entry.recipient, entry.subject.slice(0, 200),
      entry.status, entry.providerMessageId ?? null,
      entry.errorMessage ? entry.errorMessage.slice(0, 500) : null, entry.sentBy ?? null,
    ],
  );
}

export interface WhatsAppMessageRow {
  id: string;
  booking_id: string | null;
  direction: string;
  recipient: string;
  body: string;
  status: string;
  provider: string;
  provider_message_id: string | null;
  error_message: string | null;
  sent_by: string | null;
  created_at: string;
}

export async function logWhatsApp(
  entry: {
    bookingId: string | null;
    recipient: string;
    body: string;
    status: NotificationStatus;
    provider?: string;
    providerMessageId?: string | null;
    errorMessage?: string | null;
    sentBy?: string | null;
  },
  q: Queryable = db(),
): Promise<void> {
  await q.query(
    `INSERT INTO whatsapp_messages
       (booking_id, recipient, body, status, provider, provider_message_id, error_message, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.bookingId, entry.recipient, entry.body.slice(0, 4000), entry.status,
      entry.provider ?? 'openwa', entry.providerMessageId ?? null,
      entry.errorMessage ? entry.errorMessage.slice(0, 500) : null, entry.sentBy ?? null,
    ],
  );
}

export async function listWhatsAppMessages(bookingId: string, q: Queryable = db()): Promise<WhatsAppMessageRow[]> {
  const { rows } = await q.query<WhatsAppMessageRow>(
    `SELECT id::text AS id, booking_id::text AS booking_id, direction, recipient, body,
            status, provider, provider_message_id, error_message,
            sent_by::text AS sent_by, created_at
       FROM whatsapp_messages WHERE booking_id = $1 ORDER BY created_at DESC`,
    [bookingId],
  );
  return rows;
}
