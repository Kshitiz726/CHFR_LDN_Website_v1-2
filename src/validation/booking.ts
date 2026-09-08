import { z } from 'zod';
import { codesFor } from '../domain/refOptions.js';
import { isValidPhone, normalisePhone } from '../utils/phone.js';
import { isValidIsoDate, todayIso } from '../utils/dates.js';

/**
 * Server-side validation for the public booking form. This is the authority —
 * the browser's own validation is a convenience only.
 */

const trimmed = (max: number) => z.string().trim().max(max);

/** `.strict()` rejects unexpected fields outright rather than silently dropping them. */
export const publicBookingSchema = z
  .object({
    full_name: trimmed(120).min(2, 'Please enter your full name.'),
    mobile: trimmed(32).min(6, 'Please enter a valid mobile number.'),
    email: trimmed(200).email('Please enter a valid email address.'),

    pickup_location: trimmed(300).min(2, 'Please enter a pickup location.'),
    destination: trimmed(300).min(2, 'Please enter a destination.'),
    journey_date: z.string().trim().refine(isValidIsoDate, 'Please choose a valid date.'),
    pickup_time: z
      .string()
      .trim()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Please choose a valid pickup time.'),

    passengers: z.coerce.number().int('Passengers must be a whole number.').min(1, 'At least 1 passenger.').max(16, 'For more than 16 passengers please contact us directly.'),
    luggage: trimmed(40).default('NONE'),
    journey_type: trimmed(40).default('OTHER'),
    preferred_vehicle: trimmed(40).default('RECOMMEND'),

    flight_number: trimmed(20).optional().or(z.literal('')),
    special_requests: trimmed(2000).optional().or(z.literal('')),

    // Anti-spam + idempotency. Never persisted as-is.
    company_website: z.string().max(200).optional(), // honeypot
    idempotency_key: trimmed(100).optional(),
    turnstile_token: z.string().max(4000).optional(),
    consent: z.union([z.boolean(), z.string()]).optional(),
  })
  .strict();

export type PublicBookingInput = z.infer<typeof publicBookingSchema>;

export interface ValidatedBooking {
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
}

export interface FieldIssue {
  field: string;
  message: string;
}

export interface ValidationOutcome {
  ok: boolean;
  issues: FieldIssue[];
  value?: ValidatedBooking;
  raw?: PublicBookingInput;
}

/**
 * Validates shape, then the parts that need the database (enum membership) and
 * the parts that need a real phone-number parser.
 */
export async function validatePublicBooking(payload: unknown): Promise<ValidationOutcome> {
  const parsed = publicBookingSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        field: String(i.path[0] ?? 'form'),
        message:
          i.code === 'unrecognized_keys'
            ? 'Unexpected field in submission.'
            : i.message,
      })),
    };
  }

  const data = parsed.data;
  const issues: FieldIssue[] = [];

  const mobile = normalisePhone(data.mobile);
  if (!mobile || !isValidPhone(data.mobile)) {
    issues.push({ field: 'mobile', message: 'Please enter a valid mobile number, including country code.' });
  }

  // Journeys cannot be requested for a date that has already passed in the UK.
  if (data.journey_date < todayIso()) {
    issues.push({ field: 'journey_date', message: 'Please choose today or a future date.' });
  }

  const [luggage, journeyTypes, vehicles] = await Promise.all([
    codesFor('luggage'),
    codesFor('journey_type'),
    codesFor('vehicle'),
  ]);

  if (!luggage.includes(data.luggage)) {
    issues.push({ field: 'luggage', message: 'Please choose a luggage option from the list.' });
  }
  if (!journeyTypes.includes(data.journey_type)) {
    issues.push({ field: 'journey_type', message: 'Please choose a journey type from the list.' });
  }
  if (!vehicles.includes(data.preferred_vehicle)) {
    issues.push({ field: 'preferred_vehicle', message: 'Please choose a vehicle from the list.' });
  }

  if (issues.length) return { ok: false, issues, raw: data };

  return {
    ok: true,
    issues: [],
    raw: data,
    value: {
      full_name: data.full_name,
      mobile: mobile!,
      email: data.email.toLowerCase(),
      pickup_location: data.pickup_location,
      destination: data.destination,
      journey_date: data.journey_date,
      pickup_time: data.pickup_time,
      passengers: data.passengers,
      luggage: data.luggage,
      journey_type: data.journey_type,
      preferred_vehicle: data.preferred_vehicle,
      flight_number: data.flight_number ? data.flight_number.toUpperCase() : null,
      special_requests: data.special_requests || null,
    },
  };
}
