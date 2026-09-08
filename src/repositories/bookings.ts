import { db, type Queryable } from '../db/index.js';
import type { BookingRow, BookingEventRow } from '../domain/booking.js';

/**
 * All booking SQL lives here. Every statement is parameterised — no user input
 * is ever concatenated into SQL.
 */

// Dates and times are cast to text so both drivers return plain strings and a
// journey date can never shift because of a server timezone.
const BOOKING_COLUMNS = `
  b.id::text                                   AS id,
  b.booking_reference,
  b.full_name, b.mobile, b.email,
  b.pickup_location, b.destination,
  to_char(b.journey_date, 'YYYY-MM-DD')        AS journey_date,
  to_char(b.pickup_time, 'HH24:MI')            AS pickup_time,
  b.passengers, b.luggage, b.journey_type, b.preferred_vehicle,
  b.flight_number, b.special_requests,
  b.status, b.priority,
  b.assigned_to::text                          AS assigned_to,
  u.name                                       AS assigned_to_name,
  b.quoted_price::float8                       AS quoted_price,
  b.confirmed_price::float8                    AS confirmed_price,
  b.currency, b.payment_status,
  b.driver_name, b.vehicle_registration,
  b.internal_notes, b.customer_notes,
  b.customer_email_sent, b.internal_email_sent,
  b.whatsapp_sent, b.whatsapp_message_id, b.whatsapp_status,
  b.last_contacted_at,
  b.sheet_row_number, b.sheet_synced_at, b.sheet_status,
  b.source, b.archived_at,
  b.created_at, b.updated_at
`;

const FROM = `FROM bookings b LEFT JOIN users u ON u.id = b.assigned_to`;

export interface CreateBookingData {
  booking_reference: string;
  full_name: string;
  mobile: string;
  email: string;
  pickup_location: string;
  destination: string;
  journey_date: string;
  pickup_time: string;
  passengers: number;
  luggage: string;
  journey_type: string;
  preferred_vehicle: string;
  flight_number: string | null;
  special_requests: string | null;
  currency: string;
  source: string;
  user_agent: string | null;
  ip_hash: string | null;
  dedupe_hash: string;
}

export async function insertBooking(tx: Queryable, data: CreateBookingData): Promise<BookingRow> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO bookings (
       booking_reference, full_name, mobile, email,
       pickup_location, destination, journey_date, pickup_time,
       passengers, luggage, journey_type, preferred_vehicle,
       flight_number, special_requests, currency,
       source, user_agent, ip_hash, dedupe_hash
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
     ) RETURNING id::text AS id`,
    [
      data.booking_reference, data.full_name, data.mobile, data.email,
      data.pickup_location, data.destination, data.journey_date, data.pickup_time,
      data.passengers, data.luggage, data.journey_type, data.preferred_vehicle,
      data.flight_number, data.special_requests, data.currency,
      data.source, data.user_agent, data.ip_hash, data.dedupe_hash,
    ],
  );
  const id = rows[0]!.id;
  return (await findByIdWith(tx, id))!;
}

async function findByIdWith(q: Queryable, id: string): Promise<BookingRow | null> {
  const { rows } = await q.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} ${FROM} WHERE b.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function findById(id: string, q: Queryable = db()): Promise<BookingRow | null> {
  if (!/^\d+$/.test(String(id))) return null;
  return findByIdWith(q, id);
}

export async function findByReference(reference: string, q: Queryable = db()): Promise<BookingRow | null> {
  const { rows } = await q.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} ${FROM} WHERE b.booking_reference = $1`,
    [reference],
  );
  return rows[0] ?? null;
}

export async function findByIdempotencyKey(key: string, q: Queryable = db()): Promise<BookingRow | null> {
  const { rows } = await q.query<{ booking_id: string }>(
    'SELECT booking_id::text AS booking_id FROM idempotency_keys WHERE key = $1',
    [key],
  );
  const id = rows[0]?.booking_id;
  return id ? findByIdWith(q, id) : null;
}

export async function recordIdempotencyKey(tx: Queryable, key: string, bookingId: string): Promise<void> {
  await tx.query(
    'INSERT INTO idempotency_keys (key, booking_id) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
    [key, bookingId],
  );
}

/**
 * Second duplicate guard: an identical journey from the same customer within
 * the window is treated as a repeat submission rather than a new booking.
 */
export async function findRecentDuplicate(
  dedupeHash: string,
  withinMinutes: number,
  q: Queryable = db(),
): Promise<BookingRow | null> {
  const { rows } = await q.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} ${FROM}
      WHERE b.dedupe_hash = $1
        AND b.created_at > now() - ($2 || ' minutes')::interval
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [dedupeHash, String(withinMinutes)],
  );
  return rows[0] ?? null;
}

/** Applies a partial update. Column names come from a fixed allow-list upstream. */
export async function updateBookingFields(
  tx: Queryable,
  id: string,
  patch: Record<string, unknown>,
): Promise<BookingRow | null> {
  const entries = Object.entries(patch);
  if (entries.length === 0) return findByIdWith(tx, id);

  const sets = entries.map(([col], i) => `${col} = $${i + 2}`);
  sets.push('updated_at = now()');
  await tx.query(
    `UPDATE bookings SET ${sets.join(', ')} WHERE id = $1`,
    [id, ...entries.map(([, v]) => v)],
  );
  return findByIdWith(tx, id);
}

export async function markCommunication(
  id: string,
  patch: Partial<{
    customer_email_sent: boolean;
    internal_email_sent: boolean;
    whatsapp_sent: boolean;
    whatsapp_message_id: string | null;
    whatsapp_status: string;
    last_contacted_at: string | null;
    sheet_row_number: number | null;
    sheet_synced_at: string | null;
    sheet_status: string;
  }>,
  q: Queryable = db(),
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([col], i) => `${col} = $${i + 2}`);
  await q.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
}

export interface BookingListFilters {
  search?: string;
  status?: string[];
  journey_type?: string;
  preferred_vehicle?: string;
  priority?: string;
  assigned_to?: string;
  date_from?: string;
  date_to?: string;
  created_from?: string;
  created_to?: string;
  includeArchived?: boolean;
  onlyArchived?: boolean;
  sort?: 'newest' | 'oldest' | 'journey_date' | 'journey_date_desc' | 'updated';
  limit?: number;
  offset?: number;
}

const SORTS: Record<string, string> = {
  newest: 'b.created_at DESC',
  oldest: 'b.created_at ASC',
  journey_date: 'b.journey_date ASC, b.pickup_time ASC',
  journey_date_desc: 'b.journey_date DESC, b.pickup_time DESC',
  updated: 'b.updated_at DESC',
};

function buildWhere(f: BookingListFilters): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => {
    where.push(sql.replace(/\$\?/g, () => `$${params.push(values.shift()) }`));
  };

  if (f.onlyArchived) where.push('b.archived_at IS NOT NULL');
  else if (!f.includeArchived) where.push('b.archived_at IS NULL');

  if (f.search?.trim()) {
    const term = `%${f.search.trim().toLowerCase()}%`;
    // Phone search ignores formatting, and drops a UK trunk '0', so
    // "07700 900000" finds the stored E.164 "+447700900000".
    const digits = f.search.replace(/\D/g, '').replace(/^0+/, '');
    params.push(term);
    const p = params.length;
    let clause =
      `(lower(b.booking_reference) LIKE $${p} OR lower(b.full_name) LIKE $${p} ` +
      `OR lower(b.email) LIKE $${p} OR lower(b.pickup_location) LIKE $${p} ` +
      `OR lower(b.destination) LIKE $${p} OR lower(coalesce(b.flight_number,'')) LIKE $${p}`;
    if (digits.length >= 5) {
      params.push(`%${digits}%`);
      clause += ` OR regexp_replace(b.mobile, '[^0-9]', '', 'g') LIKE $${params.length}`;
    }
    where.push(`${clause})`);
  }

  if (f.status?.length) {
    params.push(f.status);
    where.push(`b.status = ANY($${params.length})`);
  }
  for (const [col, value] of [
    ['journey_type', f.journey_type],
    ['preferred_vehicle', f.preferred_vehicle],
    ['priority', f.priority],
  ] as const) {
    if (value) {
      params.push(value);
      where.push(`b.${col} = $${params.length}`);
    }
  }
  if (f.assigned_to) {
    if (f.assigned_to === 'unassigned') where.push('b.assigned_to IS NULL');
    else {
      params.push(f.assigned_to);
      where.push(`b.assigned_to = $${params.length}::bigint`);
    }
  }
  for (const [col, op, value] of [
    ['journey_date', '>=', f.date_from],
    ['journey_date', '<=', f.date_to],
  ] as const) {
    if (value) {
      params.push(value);
      where.push(`b.${col} ${op} $${params.length}::date`);
    }
  }
  if (f.created_from) {
    params.push(f.created_from);
    where.push(`b.created_at >= $${params.length}::date`);
  }
  if (f.created_to) {
    params.push(f.created_to);
    where.push(`b.created_at < ($${params.length}::date + interval '1 day')`);
  }
  void add;
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function listBookings(
  filters: BookingListFilters,
  q: Queryable = db(),
): Promise<{ rows: BookingRow[]; total: number }> {
  const { clause, params } = buildWhere(filters);
  const order = SORTS[filters.sort ?? 'newest'] ?? SORTS.newest;
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 1000);
  const offset = Math.max(filters.offset ?? 0, 0);

  const [list, count] = await Promise.all([
    q.query<BookingRow>(
      `SELECT ${BOOKING_COLUMNS} ${FROM} ${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    q.query<{ total: string }>(`SELECT count(*)::text AS total ${FROM} ${clause}`, params),
  ]);

  return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
}

/** Unbounded variant used by exports and the spreadsheet sync. */
export async function listAllBookings(filters: BookingListFilters, q: Queryable = db()): Promise<BookingRow[]> {
  const { rows } = await listBookings({ ...filters, limit: 10_000, offset: 0 }, q);
  return rows;
}

export async function archiveBooking(tx: Queryable, id: string, userId: string): Promise<void> {
  await tx.query('UPDATE bookings SET archived_at = now(), archived_by = $2, updated_at = now() WHERE id = $1', [id, userId]);
}

export async function restoreBooking(tx: Queryable, id: string): Promise<void> {
  await tx.query('UPDATE bookings SET archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = $1', [id]);
}

/** Permanent removal. ADMIN only, and enforced at the route layer. */
export async function hardDeleteBooking(tx: Queryable, id: string): Promise<void> {
  await tx.query('DELETE FROM bookings WHERE id = $1', [id]);
}

// ---------------------------------------------------------------- audit trail

export interface AuditEntry {
  event_type: string;
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  message?: string | null;
  changed_by?: string | null;
  changed_by_label?: string;
}

export async function appendEvent(q: Queryable, bookingId: string, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO booking_events
       (booking_id, event_type, field, old_value, new_value, message, changed_by, changed_by_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      bookingId,
      entry.event_type,
      entry.field ?? null,
      entry.old_value ?? null,
      entry.new_value ?? null,
      entry.message ?? null,
      entry.changed_by ?? null,
      entry.changed_by_label ?? 'System',
    ],
  );
}

export async function listEvents(bookingId: string, q: Queryable = db()): Promise<BookingEventRow[]> {
  const { rows } = await q.query<BookingEventRow>(
    `SELECT id::text AS id, booking_id::text AS booking_id, event_type, field,
            old_value, new_value, message, changed_by::text AS changed_by,
            changed_by_label, created_at
       FROM booking_events
      WHERE booking_id = $1
      ORDER BY created_at DESC, id DESC`,
    [bookingId],
  );
  return rows;
}

// ------------------------------------------------------------------ dashboard

export async function statusCounts(q: Queryable = db()): Promise<Record<string, number>> {
  const { rows } = await q.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM bookings WHERE archived_at IS NULL GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}

export interface DashboardMetrics {
  statusCounts: Record<string, number>;
  todayCount: number;
  upcomingCount: number;
  uncontactedCount: number;
  failedNotifications: number;
  goingToday: number;
}

export async function dashboardMetrics(today: string, q: Queryable = db()): Promise<DashboardMetrics> {
  const [counts, misc] = await Promise.all([
    statusCounts(q),
    q.query<{
      today_count: string;
      upcoming_count: string;
      uncontacted: string;
      going_today: string;
      failed_notifications: string;
    }>(
      `SELECT
         (SELECT count(*) FROM bookings WHERE archived_at IS NULL AND journey_date = $1::date)::text AS today_count,
         (SELECT count(*) FROM bookings WHERE archived_at IS NULL AND journey_date > $1::date)::text AS upcoming_count,
         (SELECT count(*) FROM bookings WHERE archived_at IS NULL AND status = 'NEW_LEAD')::text AS uncontacted,
         (SELECT count(*) FROM bookings WHERE archived_at IS NULL AND journey_date = $1::date AND status = 'GOING')::text AS going_today,
         (SELECT count(*) FROM notification_logs WHERE status = 'FAILED')::text AS failed_notifications`,
      [today],
    ),
  ]);

  const m = misc.rows[0];
  return {
    statusCounts: counts,
    todayCount: Number(m?.today_count ?? 0),
    upcomingCount: Number(m?.upcoming_count ?? 0),
    uncontactedCount: Number(m?.uncontacted ?? 0),
    goingToday: Number(m?.going_today ?? 0),
    failedNotifications: Number(m?.failed_notifications ?? 0),
  };
}
