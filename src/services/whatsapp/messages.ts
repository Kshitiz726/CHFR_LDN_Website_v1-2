import type { BookingRow } from '../../domain/booking.js';
import { labelFromMap, type RefOption } from '../../domain/refOptions.js';
import { formatLongDate, formatTime } from '../../utils/dates.js';

/**
 * WhatsApp message bodies. Plain text with WhatsApp's *bold* markup — kept
 * separate from the provider so the wording can change without touching the
 * transport.
 */
export function newBookingWhatsApp(
  booking: BookingRow,
  refs: Map<string, RefOption[]>,
  appUrl: string,
): string {
  const b = booking;
  const lines = [
    '🚘 *NEW CHFR BOOKING*',
    '',
    `*Booking:* ${b.booking_reference}`,
    '',
    '*Customer*',
    b.full_name,
    b.mobile,
    b.email,
    '',
    '*Journey*',
    `📍 Pickup: ${b.pickup_location}`,
    `🏁 Destination: ${b.destination}`,
    '',
    `📅 Date: ${formatLongDate(b.journey_date)}`,
    `⏰ Time: ${formatTime(b.pickup_time)}`,
    `👥 Passengers: ${b.passengers}`,
    `🧳 Luggage: ${labelFromMap(refs, 'luggage', b.luggage)}`,
    '',
    `🚘 Vehicle: ${labelFromMap(refs, 'vehicle', b.preferred_vehicle)}`,
    b.flight_number ? `✈️ Flight: ${b.flight_number}` : null,
    '',
    '*Journey Type*',
    labelFromMap(refs, 'journey_type', b.journey_type),
  ];

  if (b.special_requests) {
    lines.push('', '*Special Requests*', b.special_requests);
  }

  lines.push(
    '',
    '*Status*',
    labelFromMap(refs, 'status', b.status),
    '',
    'Open booking:',
    `${appUrl}/admin/bookings/${b.id}`,
  );

  return lines.filter((l) => l !== null).join('\n');
}
