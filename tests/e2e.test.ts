import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  setupTestApp, teardownTestApp, resetData, createTestUser, signIn, type TestContext,
} from './helpers.js';
import { db } from '../src/db/index.js';
import { BOOKING_REFERENCE_PATTERN } from '../src/domain/reference.js';
import { todayIso, addDaysIso } from '../src/utils/dates.js';
import { newBookingWhatsApp } from '../src/services/whatsapp/messages.js';
import { loadRefOptions } from '../src/domain/refOptions.js';

/**
 * The complete journey described in the brief: John Smith submits the public
 * booking form, and every downstream expectation is verified end to end.
 */
describe('end-to-end: customer submits, staff works the lead', () => {
  let ctx: TestContext;
  let reference: string;
  let bookingId: string;
  let cookie: string;
  let csrf: string;

  const journeyDate = addDaysIso(todayIso(), 14);

  const submission = {
    full_name: 'John Smith',
    mobile: '+447700900000',
    email: 'john@example.com',
    pickup_location: 'Heathrow Terminal 5',
    destination: 'The Savoy, London',
    journey_date: journeyDate,
    pickup_time: '14:30',
    passengers: 2,
    luggage: 'BAGS_1_2',
    journey_type: 'AIRPORT_TRANSFER',
    preferred_vehicle: 'MERCEDES_S_CLASS',
    flight_number: 'BA249',
    special_requests: 'Meet inside arrivals.',
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    await resetData();
    ctx.whatsapp.configured = true;
  });

  afterAll(teardownTestApp);

  it('0. every external host the public pages load is allowed by the CSP', async () => {
    // A blocked font host does not error anywhere visible: the page just
    // silently renders in a fallback face and no longer looks like CHFR.
    const csp = (await request(ctx.app).get('/')).headers['content-security-policy'] ?? '';

    for (const page of ['/', '/privacy.html', '/terms.html']) {
      const html = (await request(ctx.app).get(page)).text;
      // Only tags that actually fetch something. A canonical URL or an og:url
      // is metadata, and an <a href> is navigation; neither is a CSP concern.
      const hosts = new Set([
        ...[...html.matchAll(/<link\b[^>]*\brel="(?:stylesheet|preconnect|preload)"[^>]*>/g)]
          .flatMap((tag) => [...tag[0]!.matchAll(/href="(https:\/\/[^/"]+)/g)])
          .map((m) => m[1]!),
        ...[...html.matchAll(/<(?:script|img)\b[^>]*\bsrc="(https:\/\/[^/"]+)/g)].map((m) => m[1]!),
      ]);

      for (const host of hosts) {
        expect(csp, `${page} loads ${host}, which the CSP must allow`).toContain(host);
      }
    }
  });

  it('1. the booking form on the public site posts to the API', async () => {
    const page = await request(ctx.app).get('/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="bookingForm"');
    // Every field the API expects is present in the markup.
    for (const field of Object.keys(submission)) {
      expect(page.text, field).toContain(`name="${field}"`);
    }
    expect(page.text).toContain('name="company_website"'); // honeypot
    expect(page.text).toContain('action="/api/bookings"');
    // The brief requires the site to keep saying this. The wording is the
    // site's own; what matters is that the promise is still on the page.
    expect(page.text).toContain('No card details are ever requested online');
  });

  it('2. the submission is accepted and a booking reference is generated', async () => {
    const res = await request(ctx.app).post('/api/bookings').send(submission);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    reference = res.body.data.booking_reference;
    expect(reference).toMatch(BOOKING_REFERENCE_PATTERN);
    expect(res.body.data.message).toContain('confirm availability and pricing');
  });

  it('3. a database record exists with every field intact', async () => {
    const { rows } = await db().query(
      `SELECT id::text AS id, booking_reference, full_name, mobile, email,
              pickup_location, destination,
              to_char(journey_date,'YYYY-MM-DD') AS journey_date,
              to_char(pickup_time,'HH24:MI') AS pickup_time,
              passengers, luggage, journey_type, preferred_vehicle,
              flight_number, special_requests, status, currency, source
         FROM bookings WHERE booking_reference = $1`,
      [reference],
    );

    expect(rows).toHaveLength(1);
    const b = rows[0];
    bookingId = b.id;

    expect(b.full_name).toBe('John Smith');
    expect(b.mobile).toBe('+447700900000');
    expect(b.email).toBe('john@example.com');
    expect(b.pickup_location).toBe('Heathrow Terminal 5');
    expect(b.destination).toBe('The Savoy, London');
    expect(b.journey_date).toBe(journeyDate);
    expect(b.pickup_time).toBe('14:30');
    expect(b.passengers).toBe(2);
    expect(b.luggage).toBe('BAGS_1_2');
    expect(b.journey_type).toBe('AIRPORT_TRANSFER');
    expect(b.preferred_vehicle).toBe('MERCEDES_S_CLASS');
    expect(b.flight_number).toBe('BA249');
    expect(b.special_requests).toBe('Meet inside arrivals.');
    expect(b.status).toBe('NEW_LEAD');
    expect(b.currency).toBe('GBP');
    expect(b.source).toBe('WEBSITE');
  });

  it('4. the internal email to CHFRLONDON@GMAIL.COM is generated correctly', async () => {
    const mail = ctx.email.outbox.find((m) => m.to === 'CHFRLONDON@GMAIL.COM');
    expect(mail).toBeDefined();
    expect(mail!.content.subject).toBe(`New CHFR booking ${reference} from John Smith`);

    for (const fragment of [
      reference, 'John Smith', '+447700900000', 'john@example.com',
      'Heathrow Terminal 5', 'The Savoy, London', '14:30',
      'Airport Transfer', 'Mercedes S-Class', 'BA249', 'Meet inside arrivals.',
      'New Lead', 'Open booking',
    ]) {
      expect(mail!.content.html, fragment).toContain(fragment);
    }
    expect(mail!.content.html).toContain(`https://chfr.test/admin/bookings/${bookingId}`);
    // Renders on mobile and desktop: table layout, no external CSS.
    expect(mail!.content.html).toContain('max-width:600px');
    expect(mail!.content.text).toContain(reference);
  });

  it('5. the customer acknowledgement is generated and does not confirm the booking', async () => {
    const mail = ctx.email.outbox.find((m) => m.to === 'john@example.com');
    expect(mail).toBeDefined();
    expect(mail!.content.subject).toBe(`CHFR LDN Booking Request Received, reference ${reference}`);
    expect(mail!.content.text).toContain('Dear John,');
    expect(mail!.content.text).toContain('We have received your chauffeur request.');
    expect(mail!.content.text).toContain('Luxury. Driven.');
    expect(mail!.content.html).toContain('booking request, not a confirmation');
    expect(mail!.content.html).toContain('never ask for card details online');
  });

  it('6. a spreadsheet row is created with clean, readable values', async () => {
    expect(ctx.sheet.rows.has(reference)).toBe(true);
    const row = ctx.sheet.rows.get(reference)!;
    const { SHEET_HEADERS } = await import('../src/services/spreadsheet/columns.js');

    expect(row).toHaveLength(SHEET_HEADERS.length);
    expect(row[SHEET_HEADERS.indexOf('Booking Ref')]).toBe(reference);
    expect(row[SHEET_HEADERS.indexOf('Status')]).toBe('New Lead');
    expect(row[SHEET_HEADERS.indexOf('Customer Name')]).toBe('John Smith');
    expect(row[SHEET_HEADERS.indexOf('Preferred Vehicle')]).toBe('Mercedes S-Class');
    expect(row[SHEET_HEADERS.indexOf('Passengers')]).toBe(2); // numeric, not text
    expect(String(row[SHEET_HEADERS.indexOf('Journey Date')])).toMatch(/\d{1,2} \w+ \d{4}/);
  });

  it('7. the WhatsApp payload is generated and sent to the business number', async () => {
    expect(ctx.whatsapp.sent).toHaveLength(1);
    const message = ctx.whatsapp.sent[0]!;
    expect(message.to).toBe('+447700900999');

    for (const fragment of [
      '🚘 *NEW CHFR BOOKING*', reference, 'John Smith',
      '📍 Pickup: Heathrow Terminal 5', '🏁 Destination: The Savoy, London',
      '⏰ Time: 14:30', '👥 Passengers: 2', '🧳 Luggage: 1-2 bags',
      '🚘 Vehicle: Mercedes S-Class', '✈️ Flight: BA249',
      'Airport Transfer', 'Meet inside arrivals.', 'New Lead',
      `https://chfr.test/admin/bookings/${bookingId}`,
    ]) {
      expect(message.body, fragment).toContain(fragment);
    }

    const { rows } = await db().query(
      'SELECT whatsapp_sent, whatsapp_status FROM bookings WHERE id = $1',
      [bookingId],
    );
    expect(rows[0].whatsapp_sent).toBe(true);
    expect(rows[0].whatsapp_status).toBe('SENT');
  });

  it('8. staff can sign in and view the booking', async () => {
    const { password } = await createTestUser('ADMIN');
    ({ cookie, csrf } = await signIn(ctx.app, 'admin@chfr.test', password));

    const list = await request(ctx.app).get('/admin/bookings').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.text).toContain(reference);
    expect(list.text).toContain('John Smith');

    const detail = await request(ctx.app).get(`/admin/bookings/${bookingId}`).set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('Heathrow Terminal 5');
    expect(detail.text).toContain('BA249');
    expect(detail.text).toContain('Meet inside arrivals.');
    expect(detail.text).toContain('Audit history');
  });

  it('9. staff can move the booking through the full status workflow', async () => {
    const path = ['CONTACTED', 'QUOTED', 'CONFIRMED', 'GOING', 'COMPLETED'];

    for (const status of path) {
      const res = await request(ctx.app)
        .patch(`/api/admin/bookings/${bookingId}`)
        .set('Cookie', cookie).set('X-CSRF-Token', csrf)
        .send(status === 'QUOTED' ? { status, quoted_price: 180 } : { status });
      expect(res.status, status).toBe(200);
    }

    const { rows } = await db().query(
      'SELECT status, quoted_price::float8 AS quoted_price FROM bookings WHERE id = $1',
      [bookingId],
    );
    expect(rows[0].status).toBe('COMPLETED');
    expect(rows[0].quoted_price).toBe(180);
  });

  it('10. every change produced an audit event', async () => {
    const res = await request(ctx.app)
      .get(`/api/admin/bookings/${bookingId}/history`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf);

    const events = res.body.data.events;
    const types = events.map((e: any) => e.event_type);
    expect(types).toContain('BOOKING_CREATED');
    expect(types.filter((t: string) => t === 'STATUS_CHANGED')).toHaveLength(5);

    const priceEvent = events.find((e: any) => e.field === 'quoted_price');
    expect(priceEvent.new_value).toBe('£180.00');
    expect(priceEvent.changed_by_label).toBe('Test Admin');

    const created = events.find((e: any) => e.event_type === 'BOOKING_CREATED');
    expect(created.changed_by_label).toBe('System');
  });

  it('11. the booking appears in an export with the final values', async () => {
    const res = await request(ctx.app)
      .get('/api/admin/export/bookings?format=csv')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain(reference);
    expect(res.text).toContain('Completed');
    expect(res.text).toContain('John Smith');
  });

  it('12. the WhatsApp message body matches the documented format', async () => {
    const refs = await loadRefOptions();
    const { rows } = await db().query(
      `SELECT b.id::text AS id, b.booking_reference, b.full_name, b.mobile, b.email,
              b.pickup_location, b.destination,
              to_char(b.journey_date,'YYYY-MM-DD') AS journey_date,
              to_char(b.pickup_time,'HH24:MI') AS pickup_time,
              b.passengers, b.luggage, b.journey_type, b.preferred_vehicle,
              b.flight_number, b.special_requests, b.status
         FROM bookings b WHERE b.id = $1`,
      [bookingId],
    );

    const body = newBookingWhatsApp(rows[0] as any, refs, 'https://chfr.test');
    expect(body.startsWith('🚘 *NEW CHFR BOOKING*')).toBe(true);
    expect(body).toContain('*Customer*');
    expect(body).toContain('*Journey*');
    expect(body).toContain('*Special Requests*');
    expect(body).toContain('Open booking:');
  });
});
