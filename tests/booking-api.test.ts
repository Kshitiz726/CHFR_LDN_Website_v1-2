import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  setupTestApp, teardownTestApp, resetData, sampleBooking, type TestContext,
} from './helpers.js';
import { BOOKING_REFERENCE_PATTERN } from '../src/domain/reference.js';
import { db } from '../src/db/index.js';

describe('POST /api/bookings', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);
  beforeEach(resetData);

  it('creates a booking, generates a reference and persists it', async () => {
    const res = await request(ctx.app).post('/api/bookings').send(sampleBooking());

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.booking_reference).toMatch(BOOKING_REFERENCE_PATTERN);

    const { rows } = await db().query(
      'SELECT booking_reference, full_name, mobile, status, source FROM bookings',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].full_name).toBe('John Smith');
    expect(rows[0].mobile).toBe('+447700900000');
    expect(rows[0].status).toBe('NEW_LEAD');
    expect(rows[0].source).toBe('WEBSITE');
  });

  it('issues sequential references within a day', async () => {
    const first = await request(ctx.app).post('/api/bookings').send(sampleBooking());
    const second = await request(ctx.app)
      .post('/api/bookings')
      .send(sampleBooking({ email: 'other@example.com', pickup_location: 'Gatwick' }));

    const a = first.body.data.booking_reference;
    const b = second.body.data.booking_reference;
    expect(a.endsWith('-0001')).toBe(true);
    expect(b.endsWith('-0002')).toBe(true);
  });

  it('writes a BOOKING_CREATED audit event', async () => {
    await request(ctx.app).post('/api/bookings').send(sampleBooking());
    const { rows } = await db().query('SELECT event_type, changed_by_label FROM booking_events');
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('BOOKING_CREATED');
    expect(rows[0].changed_by_label).toBe('System');
  });

  it('does not store an IP address, only a salted hash', async () => {
    await request(ctx.app)
      .post('/api/bookings')
      .set('X-Forwarded-For', '203.0.113.42')
      .send(sampleBooking());

    const { rows } = await db().query('SELECT ip_hash FROM bookings');
    expect(rows[0].ip_hash).toBeTruthy();
    expect(rows[0].ip_hash).not.toContain('203.0.113');
  });

  it('rejects an invalid submission with per-field messages', async () => {
    const res = await request(ctx.app).post('/api/bookings').send(sampleBooking({ email: 'nope', mobile: '1' }));

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.fields.map((f: any) => f.field)).toEqual(
      expect.arrayContaining(['email', 'mobile']),
    );
    const { rows } = await db().query('SELECT count(*)::int AS c FROM bookings');
    expect(rows[0].c).toBe(0);
  });

  it('silently discards a honeypot submission without creating a booking', async () => {
    const res = await request(ctx.app)
      .post('/api/bookings')
      .send({ ...sampleBooking(), company_website: 'http://spam.example' });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true); // a bot learns nothing from the response
    const { rows } = await db().query('SELECT count(*)::int AS c FROM bookings');
    expect(rows[0].c).toBe(0);
  });

  it('rejects an oversized request body', async () => {
    const res = await request(ctx.app)
      .post('/api/bookings')
      .send(sampleBooking({ special_requests: 'x'.repeat(200_000) }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('duplicate submission protection', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);
  beforeEach(resetData);

  it('returns the original booking for a repeated idempotency key', async () => {
    const payload = { ...sampleBooking(), idempotency_key: 'key-abc-123' };

    const first = await request(ctx.app).post('/api/bookings').send(payload);
    const second = await request(ctx.app).post('/api/bookings').send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.booking_reference).toBe(first.body.data.booking_reference);

    const { rows } = await db().query('SELECT count(*)::int AS c FROM bookings');
    expect(rows[0].c).toBe(1);
  });

  it('collapses an identical journey re-posted without a key', async () => {
    const first = await request(ctx.app).post('/api/bookings').send(sampleBooking());
    const second = await request(ctx.app).post('/api/bookings').send(sampleBooking());

    expect(second.body.data.booking_reference).toBe(first.body.data.booking_reference);
    const { rows } = await db().query('SELECT count(*)::int AS c FROM bookings');
    expect(rows[0].c).toBe(1);
  });

  it('re-sends the acknowledgement when a customer resubmits, without duplicating the alert', async () => {
    // Someone resubmitting the same journey has usually not seen the first
    // acknowledgement. Re-sending it is helpful; a second internal alert is not.
    ctx.email.clear();
    await request(ctx.app).post('/api/bookings').send(sampleBooking());
    expect(ctx.email.outbox).toHaveLength(3); // internal + short alert + customer

    ctx.email.clear();
    const second = await request(ctx.app).post('/api/bookings').send(sampleBooking());

    expect(second.body.data.duplicate).toBe(true);
    expect(ctx.email.outbox).toHaveLength(1);
    expect(ctx.email.outbox[0]!.to).toBe('john@example.com');
    expect(ctx.email.outbox[0]!.content.subject).toContain('Booking Request Received');

    const { rows } = await db().query('SELECT count(*)::int AS c FROM bookings');
    expect(rows[0].c).toBe(1);
  });

  it('still creates a separate booking for a genuinely different journey', async () => {
    await request(ctx.app).post('/api/bookings').send(sampleBooking());
    await request(ctx.app).post('/api/bookings').send(sampleBooking({ pickup_time: '18:00' }));

    const { rows } = await db().query('SELECT count(*)::int AS c FROM bookings');
    expect(rows[0].c).toBe(2);
  });

  it('handles concurrent submissions without duplicating a reference', async () => {
    const payloads = Array.from({ length: 5 }, (_, i) =>
      sampleBooking({ email: `c${i}@example.com`, pickup_location: `Pickup ${i}` }),
    );
    const results = await Promise.all(
      payloads.map((p) => request(ctx.app).post('/api/bookings').send(p)),
    );

    const refs = results.map((r) => r.body.data.booking_reference);
    expect(new Set(refs).size).toBe(5);
  });
});
