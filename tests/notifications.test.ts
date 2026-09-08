import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  setupTestApp, teardownTestApp, resetData, sampleBooking, type TestContext,
} from './helpers.js';
import { db } from '../src/db/index.js';

/**
 * The central guarantee of this system: a booking is never lost, and never
 * degraded, because a downstream channel is unavailable.
 */
describe('notification fan-out', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);
  beforeEach(async () => {
    await resetData();
    ctx.email.shouldFail = false;
    ctx.email.clear();
    ctx.whatsapp.shouldFail = false;
    ctx.whatsapp.sent = [];
    ctx.sheet.shouldFail = false;
    ctx.sheet.rows.clear();
  });

  it('emails CHFR and the customer, syncs the sheet and messages WhatsApp', async () => {
    const res = await request(ctx.app).post('/api/bookings').send(sampleBooking());
    const ref = res.body.data.booking_reference;

    expect(ctx.email.outbox).toHaveLength(2);

    const internal = ctx.email.outbox.find((m) => m.to === 'CHFRLONDON@GMAIL.COM')!;
    expect(internal).toBeDefined();
    expect(internal.content.subject).toBe(`NEW CHFR BOOKING — ${ref} — John Smith`);
    expect(internal.content.html).toContain('Heathrow Terminal 5');
    expect(internal.content.html).toContain(ref);
    expect(internal.content.html).toContain('/admin/bookings/'); // "Open booking" button

    const customer = ctx.email.outbox.find((m) => m.to === 'john@example.com')!;
    expect(customer).toBeDefined();
    expect(customer.content.subject).toBe(`CHFR LDN — Booking Request Received — ${ref}`);
    expect(customer.content.text).toContain('A CHFR concierge will review your request');
    // Must never imply the journey is confirmed.
    expect(customer.content.text).not.toMatch(/\bis confirmed\b/i);

    expect(ctx.sheet.rows.has(ref)).toBe(true);
    expect(ctx.whatsapp.sent).toHaveLength(1);
    expect(ctx.whatsapp.sent[0]!.to).toBe('+447700900999');
    expect(ctx.whatsapp.sent[0]!.body).toContain(ref);
  });

  it('escapes customer input in the email HTML', async () => {
    await request(ctx.app)
      .post('/api/bookings')
      .send(sampleBooking({ full_name: 'John <script>alert(1)</script> Smith' }));

    const internal = ctx.email.outbox.find((m) => m.to === 'CHFRLONDON@GMAIL.COM')!;
    expect(internal.content.html).not.toContain('<script>');
    expect(internal.content.html).toContain('&lt;script&gt;');
  });

  it('keeps the booking when email fails, and records the failure', async () => {
    ctx.email.shouldFail = true;

    const res = await request(ctx.app).post('/api/bookings').send(sampleBooking());
    expect(res.status).toBe(201);
    expect(res.body.data.booking_reference).toBeTruthy();
    // The customer is never shown the technical failure.
    expect(res.body.data.message).toContain('has been received');

    const { rows } = await db().query('SELECT internal_email_sent, customer_email_sent FROM bookings');
    expect(rows[0].internal_email_sent).toBe(false);
    expect(rows[0].customer_email_sent).toBe(false);

    const logs = await db().query(
      `SELECT status, error_message FROM notification_logs WHERE channel = 'EMAIL'`,
    );
    expect(logs.rows).toHaveLength(2);
    expect(logs.rows.every((r: any) => r.status === 'FAILED')).toBe(true);
    expect(logs.rows[0].error_message).toContain('SMTP');
  });

  it('keeps the booking when the spreadsheet fails', async () => {
    ctx.sheet.shouldFail = true;

    const res = await request(ctx.app).post('/api/bookings').send(sampleBooking());
    expect(res.status).toBe(201);

    const { rows } = await db().query('SELECT sheet_status FROM bookings');
    expect(rows[0].sheet_status).toBe('FAILED');
    expect(ctx.email.outbox).toHaveLength(2); // email was unaffected
  });

  it('keeps the booking when WhatsApp is unavailable', async () => {
    ctx.whatsapp.shouldFail = true;

    const res = await request(ctx.app).post('/api/bookings').send(sampleBooking());
    expect(res.status).toBe(201);

    const { rows } = await db().query('SELECT whatsapp_sent, whatsapp_status FROM bookings');
    expect(rows[0].whatsapp_sent).toBe(false);
    expect(rows[0].whatsapp_status).toBe('FAILED');
    expect(ctx.email.outbox).toHaveLength(2);
  });

  it('survives every channel failing at once', async () => {
    ctx.email.shouldFail = true;
    ctx.sheet.shouldFail = true;
    ctx.whatsapp.shouldFail = true;

    const res = await request(ctx.app).post('/api/bookings').send(sampleBooking());

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    const { rows } = await db().query('SELECT booking_reference FROM bookings');
    expect(rows).toHaveLength(1);
  });

  it('returns a generic failure, not a stack trace, when the database is down', async () => {
    const { __setDatabaseForTests } = await import('../src/db/index.js');
    const real = db();
    // Stand in a database that fails on the write path only, so validation
    // (which reads reference data) still runs.
    const broken = {
      driver: real.driver,
      query: async (sql: string, params?: readonly unknown[]) => {
        if (/INSERT INTO bookings|booking_sequences/i.test(sql)) {
          throw new Error('connection to server at "db" failed: password authentication failed');
        }
        return real.query(sql, params);
      },
      exec: (sql: string) => real.exec(sql),
      transaction: async () => {
        throw new Error('connection to server at "db" failed: password authentication failed');
      },
      close: async () => undefined,
    };
    __setDatabaseForTests(broken as any);

    const res = await request(ctx.app).post('/api/bookings').send(sampleBooking());

    __setDatabaseForTests(real);
    expect(res.status).toBe(500);
    // Assert the properties that matter rather than the exact wording, so
    // copy changes do not break the test but a leak still would.
    const shown = res.body.error.message as string;
    expect(shown).toContain('try again');
    expect(shown).toContain('@chfrldn'); // always offers a way through
    expect(shown).not.toMatch(/postgres|password|connection|SQL|stack/i);
    expect(JSON.stringify(res.body)).not.toContain('password authentication');
  });
});

describe('GET /api/health', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);

  it('reports every subsystem', async () => {
    const res = await request(ctx.app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.database.status).toBe('CONNECTED');
    expect(res.body.checks.application.status).toBe('HEALTHY');
    expect(res.body.checks).toHaveProperty('email');
    expect(res.body.checks).toHaveProperty('spreadsheet');
    expect(res.body.checks).toHaveProperty('whatsapp');
  });

  it('does not leak credential values', async () => {
    // Configure real-looking secrets, then assert none of their VALUES appear.
    // Matching on variable names instead would flag the harmless
    // "No RESEND_API_KEY is set" diagnostic, which contains no secret.
    const secrets = {
      SMTP_PASSWORD: 'abcd-efgh-ijkl-mnop-secret',
      RESEND_API_KEY: 're_live_TOPSECRETVALUE123',
      OPENWA_API_KEY: 'openwa-topsecret-key-999',
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key":"-----BEGIN PRIVATE KEY-----AAA"}',
    };
    const previous = { ...process.env };
    Object.assign(process.env, secrets);

    const res = await request(ctx.app).get('/api/health?deep=1');
    const body = JSON.stringify(res.body);
    for (const [name, value] of Object.entries(secrets)) {
      expect(body, `${name} value leaked`).not.toContain(value);
    }
    expect(body).not.toContain('BEGIN PRIVATE KEY');

    process.env = previous;
  });
});
