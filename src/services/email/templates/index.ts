import type { BookingRow } from '../../../domain/booking.js';
import { labelFromMap, type RefOption } from '../../../domain/refOptions.js';
import { formatLongDate, formatTime, formatDateTime } from '../../../utils/dates.js';
import { layout, renderSection, renderFreeText, renderButton } from './layout.js';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface TemplateContext {
  booking: BookingRow;
  refs: Map<string, RefOption[]>;
  appUrl: string;
}

const firstName = (full: string) => (full ?? '').trim().split(/\s+/)[0] || 'there';

function money(amount: number | null, currency: string): string | null {
  if (amount === null || amount === undefined) return null;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** Journey facts shared by every template, already turned into human labels. */
function journeyFacts(ctx: TemplateContext) {
  const { booking: b, refs } = ctx;
  return {
    vehicle: labelFromMap(refs, 'vehicle', b.preferred_vehicle),
    journeyType: labelFromMap(refs, 'journey_type', b.journey_type),
    luggage: labelFromMap(refs, 'luggage', b.luggage),
    status: labelFromMap(refs, 'status', b.status),
    date: formatLongDate(b.journey_date),
    time: formatTime(b.pickup_time),
  };
}

// ------------------------------------------------- internal: new booking

export function newBookingEmail(ctx: TemplateContext): EmailContent {
  const b = ctx.booking;
  const f = journeyFacts(ctx);
  const adminLink = `${ctx.appUrl}/admin/bookings/${b.id}`;

  const body =
    renderSection({
      title: 'Customer',
      rows: [
        ['Name', b.full_name],
        ['Mobile', b.mobile],
        ['Email', b.email],
      ],
    }) +
    renderSection({
      title: 'Journey',
      rows: [
        ['Pickup', b.pickup_location],
        ['Destination', b.destination],
        ['Date', f.date],
        ['Pickup time', f.time],
        ['Passengers', String(b.passengers)],
        ['Luggage', f.luggage],
        ['Journey type', f.journeyType],
        ['Preferred vehicle', f.vehicle],
        ['Flight number', b.flight_number],
      ],
    }) +
    renderFreeText('Special requests', b.special_requests) +
    renderSection({
      title: 'Admin',
      rows: [
        ['Created', formatDateTime(b.created_at)],
        ['Source', b.source === 'WEBSITE' ? 'Website' : b.source],
        ['Status', f.status],
      ],
    }) +
    renderButton('Open booking', adminLink);

  const html = layout({
    preheader: `New booking request from ${b.full_name}, ${b.pickup_location} to ${b.destination}`,
    eyebrow: 'New booking request',
    heading: 'A new journey has been requested.',
    badge: { label: 'Booking reference', value: b.booking_reference },
    body,
    footerNote: 'This booking is a request. It is not confirmed until CHFR confirms availability and pricing with the customer.',
  });

  const text = [
    'CHFR LDN. NEW BOOKING REQUEST',
    '',
    `Booking reference: ${b.booking_reference}`,
    `Status: ${f.status}`,
    '',
    'CUSTOMER',
    `Name: ${b.full_name}`,
    `Mobile: ${b.mobile}`,
    `Email: ${b.email}`,
    '',
    'JOURNEY',
    `Pickup: ${b.pickup_location}`,
    `Destination: ${b.destination}`,
    `Date: ${f.date}`,
    `Pickup time: ${f.time}`,
    `Passengers: ${b.passengers}`,
    `Luggage: ${f.luggage}`,
    `Journey type: ${f.journeyType}`,
    `Preferred vehicle: ${f.vehicle}`,
    b.flight_number ? `Flight number: ${b.flight_number}` : null,
    '',
    b.special_requests ? `SPECIAL REQUESTS\n${b.special_requests}\n` : null,
    `Created: ${formatDateTime(b.created_at)}`,
    `Source: Website`,
    '',
    `Open booking: ${adminLink}`,
  ]
    .filter((l) => l !== null)
    .join('\n');

  return {
    subject: `New CHFR booking ${b.booking_reference} from ${b.full_name}`,
    html,
    text,
  };
}

// --------------------------------------------- internal: short alert

/**
 * A deliberately short "you have a new booking" ping, separate from the full
 * internal email. It is the at-a-glance version for a phone lock screen: who,
 * where, when, and a button into the dashboard for everything else.
 */
export function newBookingAlertEmail(ctx: TemplateContext): EmailContent {
  const b = ctx.booking;
  const f = journeyFacts(ctx);
  const adminLink = `${ctx.appUrl}/admin/bookings/${b.id}`;

  const body =
    renderSection({
      title: 'Request',
      rows: [
        ['Customer', b.full_name],
        ['Pickup', b.pickup_location],
        ['Destination', b.destination],
        ['When', `${f.date} at ${f.time}`],
        ['Vehicle', f.vehicle],
      ],
    }) + renderButton('View full details', adminLink);

  const html = layout({
    preheader: `New booking from ${b.full_name}, ${f.date} at ${f.time}`,
    eyebrow: 'New booking',
    heading: 'A new booking has come in.',
    badge: { label: 'Booking reference', value: b.booking_reference },
    body,
    footerNote: 'Full customer contact details and any special requests are on the booking page.',
  });

  const text = [
    'CHFR LDN. NEW BOOKING',
    '',
    `Reference: ${b.booking_reference}`,
    `Customer: ${b.full_name}`,
    `Pickup: ${b.pickup_location}`,
    `Destination: ${b.destination}`,
    `When: ${f.date} at ${f.time}`,
    `Vehicle: ${f.vehicle}`,
    '',
    `View full details: ${adminLink}`,
  ].join('\n');

  return { subject: `New CHFR booking ${b.booking_reference}`, html, text };
}

// ------------------------------------------- customer: acknowledgement

export function customerAcknowledgementEmail(ctx: TemplateContext): EmailContent {
  const b = ctx.booking;
  const f = journeyFacts(ctx);

  const body =
    renderSection({
      title: 'Your request',
      rows: [
        ['Pickup', b.pickup_location],
        ['Destination', b.destination],
        ['Date', f.date],
        ['Pickup time', f.time],
        ['Passengers', String(b.passengers)],
        ['Vehicle', f.vehicle],
        ['Flight number', b.flight_number],
      ],
    }) +
    renderFreeText('Special requests', b.special_requests) +
    `<tr><td style="padding:26px 30px 0;">
       <div style="font:400 14px/1.75 Arial,Helvetica,sans-serif;color:#c9c9c9;">
         A CHFR concierge will review your request and confirm availability and pricing directly with you.
         Please keep your booking reference to hand.
       </div>
     </td></tr>`;

  const html = layout({
    preheader: `We have received your chauffeur request, reference ${b.booking_reference}`,
    eyebrow: 'Booking request received',
    heading: `Dear ${firstName(b.full_name)},`,
    intro: 'Thank you for contacting CHFR LDN. We have received your chauffeur request.',
    badge: { label: 'Booking reference', value: b.booking_reference },
    body,
    footerNote:
      'This is a booking request, not a confirmation. Your journey is confirmed only once a CHFR concierge confirms availability and pricing with you. CHFR will never ask for card details online.',
  });

  const text = [
    `Dear ${firstName(b.full_name)},`,
    '',
    'Thank you for contacting CHFR LDN.',
    'We have received your chauffeur request.',
    '',
    `Booking reference: ${b.booking_reference}`,
    '',
    `Pickup: ${b.pickup_location}`,
    `Destination: ${b.destination}`,
    `Date: ${f.date}`,
    `Pickup time: ${f.time}`,
    `Passengers: ${b.passengers}`,
    `Vehicle: ${f.vehicle}`,
    '',
    'A CHFR concierge will review your request and confirm availability and pricing directly with you.',
    'Please keep your booking reference for reference.',
    '',
    'CHFR LDN.',
    'Luxury. Driven.',
    '',
    'This is a booking request, not a confirmation. CHFR will never ask for card details online.',
  ].join('\n');

  return {
    subject: `CHFR LDN Booking Request Received, reference ${b.booking_reference}`,
    html,
    text,
  };
}

// ------------------------------------------------- customer: confirmed

export function bookingConfirmedEmail(ctx: TemplateContext): EmailContent {
  const b = ctx.booking;
  const f = journeyFacts(ctx);
  const price = money(b.confirmed_price ?? b.quoted_price, b.currency);

  // The chauffeur section only appears once the operator has actually filled it
  // in, so a confirmation sent before the driver is allocated never shows blanks.
  const chauffeurRows: Array<[string, string | null]> = [
    ['Chauffeur', b.driver_name],
    ['Vehicle registration', b.vehicle_registration],
  ];
  const hasChauffeur = chauffeurRows.some(([, v]) => v && String(v).trim() !== '');

  const body =
    renderSection({
      title: 'Your journey',
      rows: [
        ['Pickup', b.pickup_location],
        ['Destination', b.destination],
        ['Date', f.date],
        ['Arriving at', f.time],
        ['Passengers', String(b.passengers)],
        ['Luggage', f.luggage],
        ['Journey type', f.journeyType],
        ['Vehicle', f.vehicle],
        ['Flight number', b.flight_number],
      ],
    }) +
    (hasChauffeur ? renderSection({ title: 'Your chauffeur', rows: chauffeurRows }) : '') +
    renderSection({ title: 'Price', rows: [['Agreed price', price]] }) +
    renderFreeText('Special requests', b.special_requests) +
    renderFreeText('A note from CHFR', b.customer_notes);

  const intro = hasChauffeur
    ? `Your CHFR journey is confirmed. Your chauffeur will arrive at ${b.pickup_location} at ${f.time} on ${f.date}. Everything you need is below.`
    : `Your CHFR journey is confirmed. Your chauffeur will arrive at ${b.pickup_location} at ${f.time} on ${f.date}. Your chauffeur and vehicle details will follow closer to the time.`;

  const html = layout({
    preheader: `Your CHFR journey is confirmed for ${f.date}, reference ${b.booking_reference}`,
    eyebrow: 'Booking confirmed',
    heading: `Dear ${firstName(b.full_name)},`,
    intro,
    badge: { label: 'Booking reference', value: b.booking_reference },
    body,
    footerNote:
      'If anything about this journey needs to change, reply to this email or contact CHFR directly. CHFR will never ask for card details online.',
  });

  const text = [
    `Dear ${firstName(b.full_name)},`,
    '',
    intro,
    '',
    `Booking reference: ${b.booking_reference}`,
    `Pickup: ${b.pickup_location}`,
    `Destination: ${b.destination}`,
    `Date: ${f.date}`,
    `Arriving at: ${f.time}`,
    `Passengers: ${b.passengers}`,
    `Luggage: ${f.luggage}`,
    `Journey type: ${f.journeyType}`,
    `Vehicle: ${f.vehicle}`,
    b.flight_number ? `Flight number: ${b.flight_number}` : null,
    b.driver_name ? `Chauffeur: ${b.driver_name}` : null,
    b.vehicle_registration ? `Vehicle registration: ${b.vehicle_registration}` : null,
    price ? `Agreed price: ${price}` : null,
    b.special_requests ? `\nSpecial requests: ${b.special_requests}` : null,
    b.customer_notes ? `\nA note from CHFR: ${b.customer_notes}` : null,
    '',
    'CHFR LDN.',
    'Luxury. Driven.',
    '',
    'CHFR will never ask for card details online.',
  ]
    .filter((l) => l !== null)
    .join('\n');

  return { subject: `CHFR LDN Booking Confirmed, reference ${b.booking_reference}`, html, text };
}

// --------------------------------------------------- customer: updated

export function bookingUpdatedEmail(
  ctx: TemplateContext & { changes: Array<{ label: string; from: string; to: string }> },
): EmailContent {
  const b = ctx.booking;
  const f = journeyFacts(ctx);

  const changeRows = ctx.changes.map(
    (c) => [c.label, `${c.from} to ${c.to}`] as [string, string],
  );

  const body =
    renderSection({ title: 'What has changed', rows: changeRows }) +
    renderSection({
      title: 'Your journey',
      rows: [
        ['Pickup', b.pickup_location],
        ['Destination', b.destination],
        ['Date', f.date],
        ['Pickup time', f.time],
        ['Passengers', String(b.passengers)],
        ['Vehicle', f.vehicle],
      ],
    });

  const html = layout({
    preheader: `An update to your CHFR booking, reference ${b.booking_reference}`,
    eyebrow: 'Booking updated',
    heading: `Dear ${firstName(b.full_name)},`,
    intro: 'There has been an update to your CHFR booking. The current details are below.',
    badge: { label: 'Booking reference', value: b.booking_reference },
    body,
    footerNote: 'If any of this is not as expected, please contact CHFR directly.',
  });

  const text = [
    `Dear ${firstName(b.full_name)},`,
    '',
    `There has been an update to your CHFR booking ${b.booking_reference}.`,
    '',
    'WHAT HAS CHANGED',
    ...ctx.changes.map((c) => `${c.label}: ${c.from} to ${c.to}`),
    '',
    'YOUR JOURNEY',
    `Pickup: ${b.pickup_location}`,
    `Destination: ${b.destination}`,
    `Date: ${f.date}`,
    `Pickup time: ${f.time}`,
    `Vehicle: ${f.vehicle}`,
    '',
    'CHFR LDN.',
    'Luxury. Driven.',
  ].join('\n');

  return { subject: `CHFR LDN Booking Updated, reference ${b.booking_reference}`, html, text };
}

// ------------------------------------------------- customer: cancelled

export function bookingCancelledEmail(ctx: TemplateContext): EmailContent {
  const b = ctx.booking;
  const f = journeyFacts(ctx);

  const body =
    renderSection({
      title: 'Cancelled journey',
      rows: [
        ['Pickup', b.pickup_location],
        ['Destination', b.destination],
        ['Date', f.date],
        ['Pickup time', f.time],
      ],
    }) +
    `<tr><td style="padding:26px 30px 0;">
       <div style="font:400 14px/1.75 Arial,Helvetica,sans-serif;color:#c9c9c9;">
         If this was not expected, or you would like to rebook, please contact CHFR and quote your booking reference.
       </div>
     </td></tr>`;

  const html = layout({
    preheader: `Your CHFR booking has been cancelled, reference ${b.booking_reference}`,
    eyebrow: 'Booking cancelled',
    heading: `Dear ${firstName(b.full_name)},`,
    intro: 'Your CHFR booking has been cancelled.',
    badge: { label: 'Booking reference', value: b.booking_reference },
    body,
  });

  const text = [
    `Dear ${firstName(b.full_name)},`,
    '',
    `Your CHFR booking ${b.booking_reference} has been cancelled.`,
    '',
    `Pickup: ${b.pickup_location}`,
    `Destination: ${b.destination}`,
    `Date: ${f.date}`,
    `Pickup time: ${f.time}`,
    '',
    'If this was not expected, or you would like to rebook, please contact CHFR and quote your booking reference.',
    '',
    'CHFR LDN.',
    'Luxury. Driven.',
  ].join('\n');

  return { subject: `CHFR LDN Booking Cancelled, reference ${b.booking_reference}`, html, text };
}

// ------------------------------------------- staff-composed free message

export function staffMessageEmail(
  ctx: TemplateContext & { subject: string; message: string },
): EmailContent {
  const b = ctx.booking;

  const body = renderFreeText('Message', ctx.message);

  const html = layout({
    preheader: ctx.subject,
    eyebrow: 'A message from CHFR',
    heading: `Dear ${firstName(b.full_name)},`,
    badge: { label: 'Booking reference', value: b.booking_reference },
    body,
    footerNote: 'CHFR will never ask for card details online.',
  });

  const text = [
    `Dear ${firstName(b.full_name)},`,
    '',
    ctx.message,
    '',
    `Booking reference: ${b.booking_reference}`,
    '',
    'CHFR LDN.',
    'Luxury. Driven.',
  ].join('\n');

  return { subject: ctx.subject, html, text };
}

export const TEMPLATES = {
  newBooking: newBookingEmail,
  newBookingAlert: newBookingAlertEmail,
  customerAcknowledgement: customerAcknowledgementEmail,
  bookingConfirmed: bookingConfirmedEmail,
  bookingCancelled: bookingCancelledEmail,
} as const;
