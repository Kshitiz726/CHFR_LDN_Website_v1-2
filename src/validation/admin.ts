import { z } from 'zod';
import { codesFor } from '../domain/refOptions.js';
import { EDITABLE_FIELDS } from '../domain/booking.js';
import { normalisePhone } from '../utils/phone.js';
import { isValidIsoDate } from '../utils/dates.js';
import type { FieldIssue } from './booking.js';

/** Login. Deliberately permissive on shape — the failure message is always generic. */
export const loginSchema = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});

/**
 * A money field. Distinguishing "absent" from "explicitly cleared" matters:
 * a partial update that does not mention the price must leave it alone, while
 * an empty input on the full edit form means clear it.
 */
const money = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined; // not in the payload — do not touch
    if (v === null || v === '') return null; // explicitly cleared
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[£$,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  });

const nullableText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === null || v === undefined) return undefined;
      const t = String(v).trim();
      return t === '' ? null : t.slice(0, max);
    });

export const bookingUpdateSchema = z
  .object({
    full_name: z.string().trim().min(2).max(120).optional(),
    mobile: z.string().trim().min(6).max(32).optional(),
    email: z.string().trim().email().max(200).optional(),
    pickup_location: z.string().trim().min(2).max(300).optional(),
    destination: z.string().trim().min(2).max(300).optional(),
    journey_date: z.string().trim().refine(isValidIsoDate, 'Invalid date').optional(),
    pickup_time: z
      .string()
      .trim()
      .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Invalid time')
      .optional(),
    passengers: z.coerce.number().int().min(1).max(16).optional(),
    luggage: z.string().trim().max(40).optional(),
    journey_type: z.string().trim().max(40).optional(),
    preferred_vehicle: z.string().trim().max(40).optional(),
    flight_number: nullableText(20),
    special_requests: nullableText(2000),

    status: z.string().trim().max(40).optional(),
    priority: z.string().trim().max(40).optional(),
    assigned_to: z
      .union([z.string(), z.number(), z.null()])
      .optional()
      .transform((v) => {
        if (v === undefined) return undefined; // not in the payload — do not touch
        if (v === null || v === '') return null; // explicitly unassigned
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? String(n) : NaN;
      }),
    quoted_price: money,
    confirmed_price: money,
    currency: z.string().trim().length(3).toUpperCase().optional(),
    payment_status: z.string().trim().max(40).optional(),
    driver_name: nullableText(120),
    vehicle_registration: nullableText(20),
    internal_notes: nullableText(5000),
    customer_notes: nullableText(5000),

    // Control flags — consumed by the route, never written to the booking row.
    notify_customer: z.union([z.boolean(), z.string()]).optional(),
  })
  .strict();

export type BookingUpdateInput = z.infer<typeof bookingUpdateSchema>;

export interface AdminUpdateOutcome {
  ok: boolean;
  issues: FieldIssue[];
  patch?: Record<string, unknown>;
  notifyCustomer?: boolean;
}

/** Validates a staff edit and returns only the fields actually being changed. */
export async function validateBookingUpdate(payload: unknown): Promise<AdminUpdateOutcome> {
  const parsed = bookingUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        field: String(i.path[0] ?? 'form'),
        message: i.code === 'unrecognized_keys' ? 'Unexpected field.' : i.message,
      })),
    };
  }

  const { notify_customer, ...fields } = parsed.data;
  const issues: FieldIssue[] = [];
  const patch: Record<string, unknown> = {};

  const [statuses, priorities, payments, journeyTypes, vehicles, luggage] = await Promise.all([
    codesFor('status'),
    codesFor('priority'),
    codesFor('payment_status'),
    codesFor('journey_type'),
    codesFor('vehicle'),
    codesFor('luggage'),
  ]);

  const enumChecks: Array<[keyof typeof fields, string[], string]> = [
    ['status', statuses, 'status'],
    ['priority', priorities, 'priority'],
    ['payment_status', payments, 'payment status'],
    ['journey_type', journeyTypes, 'journey type'],
    ['preferred_vehicle', vehicles, 'vehicle'],
    ['luggage', luggage, 'luggage option'],
  ];

  for (const [key, allowed, label] of enumChecks) {
    const value = fields[key];
    if (value !== undefined && !allowed.includes(String(value))) {
      issues.push({ field: String(key), message: `Unknown ${label}: ${String(value)}` });
    }
  }

  if (Number.isNaN(fields.quoted_price as number)) issues.push({ field: 'quoted_price', message: 'Quoted price must be a number.' });
  if (Number.isNaN(fields.confirmed_price as number)) issues.push({ field: 'confirmed_price', message: 'Confirmed price must be a number.' });
  if (Number.isNaN(fields.assigned_to as unknown as number)) issues.push({ field: 'assigned_to', message: 'Invalid staff member.' });

  if (fields.mobile !== undefined) {
    const normalised = normalisePhone(fields.mobile);
    if (!normalised) issues.push({ field: 'mobile', message: 'Invalid mobile number.' });
    else fields.mobile = normalised;
  }

  if (issues.length) return { ok: false, issues };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!(key in EDITABLE_FIELDS)) continue;
    patch[key] = key === 'pickup_time' && typeof value === 'string' ? value.slice(0, 5) : value;
  }

  const notify =
    notify_customer === true || notify_customer === 'true' || notify_customer === 'on' || notify_customer === '1';

  return { ok: true, issues: [], patch, notifyCustomer: notify };
}

export const noteSchema = z.object({
  note: z.string().trim().min(1).max(5000),
});

export const manualWhatsAppSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  confirm: z.union([z.boolean(), z.string()]),
});

export const manualEmailSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(8000),
});

export const createUserSchema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(12, 'Password must be at least 12 characters.').max(200),
  role: z.enum(['ADMIN', 'STAFF']).default('STAFF'),
});
