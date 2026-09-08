import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  setupTestApp, teardownTestApp, resetData, createTestUser, signIn, sampleBooking, type TestContext,
} from './helpers.js';
import { db } from '../src/db/index.js';
import { todayIso, addDaysIso } from '../src/utils/dates.js';

describe('status workflow and audit log', () => {
  let ctx: TestContext;
  let cookie: string;
  let csrf: string;
  let id: string;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);

  beforeEach(async () => {
    await resetData();
    ctx.email.clear();
    const { password } = await createTestUser('ADMIN');
    ({ cookie, csrf } = await signIn(ctx.app, 'admin@chfr.test', password));
    await request(ctx.app).post('/api/bookings').send(sampleBooking());
    id = (await db().query('SELECT id::text AS id FROM bookings')).rows[0].id;
  });

  const patch = (body: Record<string, unknown>) =>
    request(ctx.app)
      .patch(`/api/admin/bookings/${id}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .send(body);

  it('moves through the full CRM workflow', async () => {
    for (const status of ['CONTACTED', 'QUOTED', 'CONFIRMED', 'GOING', 'COMPLETED']) {
      const res = await patch({ status });
      expect(res.status, status).toBe(200);
      expect(res.body.data.booking.status, status).toBe(status);
    }

    const events = await db().query(
      `SELECT old_value, new_value FROM booking_events
        WHERE event_type = 'STATUS_CHANGED' ORDER BY id`,
    );
    expect(events.rows).toHaveLength(5);
    expect(events.rows[0].old_value).toBe('New Lead');
    expect(events.rows[0].new_value).toBe('Contacted');
    expect(events.rows[4].new_value).toBe('Completed');
  });

  it('records who changed what, with readable before and after values', async () => {
    await patch({ quoted_price: 180 });
    await patch({ quoted_price: 200 });

    const { rows } = await db().query(
      `SELECT message, old_value, new_value, changed_by_label
         FROM booking_events WHERE field = 'quoted_price' ORDER BY id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].message).toBe('Quoted price changed');
    expect(rows[0].old_value).toBe('—');
    expect(rows[0].new_value).toBe('£180.00');
    expect(rows[1].old_value).toBe('£180.00');
    expect(rows[1].new_value).toBe('£200.00');
    expect(rows[1].changed_by_label).toBe('Test Admin');
  });

  it('leaves fields the payload does not mention untouched', async () => {
    // A partial update must never clear a value it says nothing about — a
    // status-only PATCH once wiped the quoted price and the assignee.
    await patch({ quoted_price: 180, confirmed_price: 195 });
    await patch({ status: 'CONFIRMED' });

    const { rows } = await db().query(
      `SELECT status, quoted_price::float8 AS quoted_price,
              confirmed_price::float8 AS confirmed_price
         FROM bookings WHERE id = $1`,
      [id],
    );
    expect(rows[0].status).toBe('CONFIRMED');
    expect(rows[0].quoted_price).toBe(180);
    expect(rows[0].confirmed_price).toBe(195);
  });

  it('clears a price when it is explicitly sent as empty', async () => {
    await patch({ quoted_price: 180 });
    await patch({ quoted_price: '' });

    const { rows } = await db().query(
      'SELECT quoted_price FROM bookings WHERE id = $1',
      [id],
    );
    expect(rows[0].quoted_price).toBeNull();
  });

  it('logs nothing when a submitted value is unchanged', async () => {
    const before = await db().query('SELECT count(*)::int AS c FROM booking_events');
    const res = await patch({ status: 'NEW_LEAD', full_name: 'John Smith' });

    expect(res.body.data.changes).toHaveLength(0);
    const after = await db().query('SELECT count(*)::int AS c FROM booking_events');
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  it('keeps the audit log append-only through the admin interface', async () => {
    await patch({ status: 'CONTACTED' });
    const before = await db().query('SELECT count(*)::int AS c FROM booking_events');

    // No route exists to edit or delete an event.
    const res = await request(ctx.app)
      .delete(`/api/admin/bookings/${id}/history`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf);
    expect(res.status).toBe(404);

    const after = await db().query('SELECT count(*)::int AS c FROM booking_events');
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  it('exposes the history over the API', async () => {
    await patch({ status: 'CONTACTED' });
    const res = await request(ctx.app)
      .get(`/api/admin/bookings/${id}/history`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf);

    expect(res.status).toBe(200);
    const types = res.body.data.events.map((e: any) => e.event_type);
    expect(types).toContain('BOOKING_CREATED');
    expect(types).toContain('STATUS_CHANGED');
  });

  it('rejects an unknown status rather than storing it', async () => {
    const res = await patch({ status: 'TELEPORTED' });
    expect(res.status).toBe(400);
    const { rows } = await db().query('SELECT status FROM bookings');
    expect(rows[0].status).toBe('NEW_LEAD');
  });

  it('accepts a status added to the reference table without a code change', async () => {
    await db().query(
      `INSERT INTO ref_options (category, code, label, sort_order, meta)
       VALUES ('status', 'EN_ROUTE', 'En Route', 65, '{"tone":"active"}')`,
    );
    const { clearRefOptionCache } = await import('../src/domain/refOptions.js');
    clearRefOptionCache();

    const res = await patch({ status: 'EN_ROUTE' });
    expect(res.status).toBe(200);
    expect(res.body.data.booking.status).toBe('EN_ROUTE');

    const page = await request(ctx.app).get(`/admin/bookings/${id}`).set('Cookie', cookie);
    expect(page.text).toContain('En Route');
  });

  it('emails the customer only for a customer-impacting change, when asked', async () => {
    ctx.email.clear();
    await patch({ internal_notes: 'Prefers a quiet chauffeur', notify_customer: true });
    expect(ctx.email.outbox).toHaveLength(0);

    await patch({ status: 'CONFIRMED', notify_customer: true });
    expect(ctx.email.outbox).toHaveLength(1);
    expect(ctx.email.outbox[0]!.content.subject).toContain('Booking Confirmed');
  });

  it('does not email the customer when the box is not ticked', async () => {
    ctx.email.clear();
    await patch({ pickup_time: '16:00' });
    expect(ctx.email.outbox).toHaveLength(0);
  });

  it('records notes, contact marks and archive/restore in the history', async () => {
    await request(ctx.app)
      .post(`/api/admin/bookings/${id}/notes`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .send({ note: 'Left a voicemail.' }).expect(200);

    await request(ctx.app)
      .post(`/api/admin/bookings/${id}/contacted`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).expect(200);

    await request(ctx.app)
      .delete(`/api/admin/bookings/${id}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).expect(200);

    await request(ctx.app)
      .post(`/api/admin/bookings/${id}/restore`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).expect(200);

    const { rows } = await db().query('SELECT event_type FROM booking_events ORDER BY id');
    const types = rows.map((r: any) => r.event_type);
    expect(types).toEqual(
      expect.arrayContaining(['BOOKING_CREATED', 'NOTE_ADDED', 'MARKED_CONTACTED', 'ARCHIVED', 'RESTORED']),
    );
  });

  it('retries a failed notification on demand', async () => {
    ctx.email.shouldFail = true;
    await request(ctx.app).post('/api/bookings').send(sampleBooking({ email: 'retry@example.com' }));
    const target = (await db().query(
      `SELECT id::text AS id FROM bookings WHERE email = 'retry@example.com'`,
    )).rows[0].id;

    let flags = await db().query('SELECT internal_email_sent FROM bookings WHERE id = $1', [target]);
    expect(flags.rows[0].internal_email_sent).toBe(false);

    ctx.email.shouldFail = false;
    const res = await request(ctx.app)
      .post(`/api/admin/bookings/${target}/retry/internal-email`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SENT');
    flags = await db().query('SELECT internal_email_sent FROM bookings WHERE id = $1', [target]);
    expect(flags.rows[0].internal_email_sent).toBe(true);
  });
});

describe('dashboard search, filters and views', () => {
  let ctx: TestContext;
  let cookie: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    await resetData();
    const { password } = await createTestUser('ADMIN');
    ({ cookie } = await signIn(ctx.app, 'admin@chfr.test', password));

    const today = todayIso();
    await request(ctx.app).post('/api/bookings').send(sampleBooking({ journey_date: today }));
    await request(ctx.app).post('/api/bookings').send(
      sampleBooking({
        full_name: 'Amara Okafor', email: 'amara@example.com', mobile: '+447911123456',
        pickup_location: 'Mayfair', destination: 'Gatwick North',
        journey_date: addDaysIso(today, 3), journey_type: 'EXECUTIVE',
        preferred_vehicle: 'ROLLS_ROYCE',
      }),
    );
    await request(ctx.app).post('/api/bookings').send(
      sampleBooking({
        full_name: 'Rafael Ortiz', email: 'rafael@example.com',
        pickup_location: 'Canary Wharf', destination: 'Manchester',
        journey_date: addDaysIso(today, 40), journey_type: 'LONG_DISTANCE',
      }),
    );
  });
  afterAll(teardownTestApp);

  const list = (qs: string) =>
    request(ctx.app).get(`/api/admin/bookings${qs}`).set('Cookie', cookie);

  it('searches by booking reference', async () => {
    const all = await list('');
    const ref = all.body.data.bookings[0].booking_reference;
    const res = await list(`?q=${encodeURIComponent(ref)}`);
    expect(res.body.data.total).toBe(1);
  });

  it('searches by customer name, email and destination', async () => {
    expect((await list('?q=Amara')).body.data.total).toBe(1);
    expect((await list('?q=rafael@example.com')).body.data.total).toBe(1);
    expect((await list('?q=Gatwick')).body.data.total).toBe(1);
  });

  it('searches by phone number regardless of formatting', async () => {
    const res = await list('?q=' + encodeURIComponent('07911 123456'));
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.bookings[0].full_name).toBe('Amara Okafor');
  });

  it('filters by journey type and vehicle', async () => {
    expect((await list('?journey_type=EXECUTIVE')).body.data.total).toBe(1);
    expect((await list('?vehicle=ROLLS_ROYCE')).body.data.total).toBe(1);
    expect((await list('?journey_type=LONG_DISTANCE')).body.data.total).toBe(1);
    expect((await list('?journey_type=AIRPORT_TRANSFER')).body.data.total).toBe(1);
  });

  it('filters by journey date range', async () => {
    const today = todayIso();
    expect((await list(`?date_from=${today}&date_to=${today}`)).body.data.total).toBe(1);
    expect((await list(`?date_from=${addDaysIso(today, 1)}`)).body.data.total).toBe(2);
  });

  it('sorts by journey date', async () => {
    const res = await list('?sort=journey_date');
    const dates = res.body.data.bookings.map((b: any) => b.journey_date);
    expect([...dates]).toEqual([...dates].sort());
  });

  it("renders today's operations view chronologically", async () => {
    const res = await request(ctx.app).get('/admin/today').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Heathrow Terminal 5');
    expect(res.text).not.toContain('Manchester'); // 40 days away
  });

  it('renders the upcoming view with range filters', async () => {
    const next7 = await request(ctx.app).get('/admin/upcoming?range=7').set('Cookie', cookie);
    expect(next7.text).toContain('Gatwick North');
    expect(next7.text).not.toContain('Manchester');

    const next30 = await request(ctx.app).get('/admin/upcoming?range=30').set('Cookie', cookie);
    expect(next30.text).toContain('Gatwick North');
  });

  it('shows overview metrics', async () => {
    const res = await request(ctx.app).get('/admin').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('New Lead');
    expect(res.text).toContain('System health');
  });
});

describe('export', () => {
  let ctx: TestContext;
  let cookie: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    await resetData();
    const { password } = await createTestUser('ADMIN');
    ({ cookie } = await signIn(ctx.app, 'admin@chfr.test', password));
    await request(ctx.app).post('/api/bookings').send(sampleBooking());
  });
  afterAll(teardownTestApp);

  it('exports clean CSV with readable headers and dates', async () => {
    const res = await request(ctx.app)
      .get('/api/admin/export/bookings?format=csv')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('chfr-bookings-');

    const [header, row] = res.text.trim().split('\r\n');
    expect(header).toContain('Booking Ref');
    expect(header).toContain('Special Requests');
    expect(header).toContain('WhatsApp Status');
    expect(row).toContain('John Smith');
    expect(row).toContain('Heathrow Terminal 5');
    // No raw JSON, no ISO timestamps in a cell.
    expect(row).not.toContain('{');
    expect(row).toMatch(/\d{1,2} \w+ \d{4}/);
  });

  it('quotes fields containing commas', async () => {
    await request(ctx.app)
      .post('/api/bookings')
      .send(sampleBooking({ email: 'comma@example.com', destination: 'Claridge\'s, Brook Street, Mayfair' }));

    const res = await request(ctx.app)
      .get('/api/admin/export/bookings?format=csv')
      .set('Cookie', cookie);
    expect(res.text).toContain('"Claridge\'s, Brook Street, Mayfair"');
  });

  it('exports a real xlsx workbook', async () => {
    const res = await request(ctx.app)
      .get('/api/admin/export/bookings?format=xlsx')
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    // XLSX is a zip archive — check the magic bytes.
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('supports scoped exports', async () => {
    for (const scope of ['today', 'upcoming', 'confirmed', 'completed', 'cancelled']) {
      const res = await request(ctx.app)
        .get(`/api/admin/export/bookings?scope=${scope}&format=csv`)
        .set('Cookie', cookie);
      expect(res.status, scope).toBe(200);
      expect(res.headers['content-disposition'], scope).toContain('chfr-bookings-');
    }
  });

  it('requires authentication', async () => {
    await request(ctx.app).get('/api/admin/export/bookings?format=csv').expect(401);
  });
});
