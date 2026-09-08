import type { Queryable } from '../db/index.js';

/**
 * Human-friendly booking reference: CHFR-YYYYMMDD-NNNN.
 *
 * The counter is allocated with a single atomic UPSERT, so two concurrent
 * submissions can never receive the same reference (the UNIQUE index on
 * bookings.booking_reference is the backstop).
 */
export async function nextBookingReference(tx: Queryable, now: Date = new Date()): Promise<string> {
  const day = formatDayKey(now);

  const { rows } = await tx.query<{ last_seq: number }>(
    `INSERT INTO booking_sequences (day, last_seq)
          VALUES ($1, 1)
     ON CONFLICT (day) DO UPDATE SET last_seq = booking_sequences.last_seq + 1
       RETURNING last_seq`,
    [day],
  );

  const seq = Number(rows[0]?.last_seq ?? 1);
  return `CHFR-${day.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}

/** YYYY-MM-DD in Europe/London, so references roll over on the UK business day. */
export function formatDayKey(date: Date, timeZone = 'Europe/London'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return parts; // en-CA renders as YYYY-MM-DD
}

export const BOOKING_REFERENCE_PATTERN = /^CHFR-\d{8}-\d{4}$/;
