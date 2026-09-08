import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  setupTestApp, teardownTestApp, resetData, createTestUser, signIn, sampleBooking, type TestContext,
} from './helpers.js';
import { db } from '../src/db/index.js';

describe('authentication', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);
  beforeEach(resetData);

  const ADMIN_PAGES = ['/admin', '/admin/bookings', '/admin/today', '/admin/upcoming', '/admin/whatsapp', '/admin/users'];
  const ADMIN_APIS = ['/api/admin/bookings', '/api/admin/health', '/api/admin/export/bookings', '/api/admin/staff'];

  it('redirects every admin page to the login screen when signed out', async () => {
    for (const path of ADMIN_PAGES) {
      const res = await request(ctx.app).get(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.location, path).toContain('/admin/login');
    }
  });

  it('returns 401 for every admin API when signed out', async () => {
    for (const path of ADMIN_APIS) {
      const res = await request(ctx.app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.error.code, path).toBe('UNAUTHENTICATED');
    }
  });

  it('never exposes booking data to an unauthenticated caller', async () => {
    await request(ctx.app).post('/api/bookings').send(sampleBooking());
    const res = await request(ctx.app).get('/api/admin/bookings');

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('john@example.com');
  });

  it('signs in with correct credentials and sets a secure session cookie', async () => {
    const { password } = await createTestUser('ADMIN');
    const res = await request(ctx.app)
      .post('/admin/login')
      .type('form')
      .send({ email: 'admin@chfr.test', password });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');

    const cookie = (res.headers['set-cookie'] ?? [])[0] ?? '';
    expect(cookie).toContain('chfr_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    await createTestUser('ADMIN');

    const wrongPassword = await request(ctx.app)
      .post('/admin/login').type('form')
      .send({ email: 'admin@chfr.test', password: 'WrongPassword123!' });
    const unknownEmail = await request(ctx.app)
      .post('/admin/login').type('form')
      .send({ email: 'nobody@chfr.test', password: 'WrongPassword123!' });

    expect(wrongPassword.headers.location).toBe(unknownEmail.headers.location);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('stores only a hash of the session token', async () => {
    const { password } = await createTestUser('ADMIN');
    const { cookie } = await signIn(ctx.app, 'admin@chfr.test', password);
    const token = decodeURIComponent(cookie.split('=')[1] ?? '');

    const { rows } = await db().query('SELECT token_hash FROM sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toHaveLength(64);
  });

  it('never stores a plaintext password', async () => {
    await createTestUser('ADMIN');
    const { rows } = await db().query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).not.toContain('CorrectHorse123!');
    expect(rows[0].password_hash.startsWith('$2')).toBe(true);
  });

  it('invalidates the session on sign-out', async () => {
    const { password } = await createTestUser('ADMIN');
    const { cookie } = await signIn(ctx.app, 'admin@chfr.test', password);

    await request(ctx.app).get('/api/admin/bookings').set('Cookie', cookie).expect(200);
    await request(ctx.app).post('/admin/logout').set('Cookie', cookie).expect(302);
    await request(ctx.app).get('/api/admin/bookings').set('Cookie', cookie).expect(401);
  });

  it('rejects a disabled account immediately, including live sessions', async () => {
    const { user, password } = await createTestUser('STAFF', 'staff@chfr.test');
    const { cookie } = await signIn(ctx.app, 'staff@chfr.test', password);

    await request(ctx.app).get('/api/admin/bookings').set('Cookie', cookie).expect(200);
    await db().query('UPDATE users SET active = false WHERE id = $1', [user.id]);
    await request(ctx.app).get('/api/admin/bookings').set('Cookie', cookie).expect(401);
  });
});

describe('CSRF protection', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);
  beforeEach(resetData);

  it('rejects a state-changing request without a token', async () => {
    const { password } = await createTestUser('ADMIN');
    const { cookie } = await signIn(ctx.app, 'admin@chfr.test', password);
    const created = await request(ctx.app).post('/api/bookings').send(sampleBooking());
    const { rows } = await db().query('SELECT id::text AS id FROM bookings');
    void created;

    const res = await request(ctx.app)
      .patch(`/api/admin/bookings/${rows[0].id}`)
      .set('Cookie', cookie)
      .send({ status: 'CONTACTED' });

    expect(res.status).toBe(403);
    const after = await db().query('SELECT status FROM bookings');
    expect(after.rows[0].status).toBe('NEW_LEAD');
  });

  it('rejects a forged token and accepts the real one', async () => {
    const { password } = await createTestUser('ADMIN');
    const { cookie, csrf } = await signIn(ctx.app, 'admin@chfr.test', password);
    await request(ctx.app).post('/api/bookings').send(sampleBooking());
    const { rows } = await db().query('SELECT id::text AS id FROM bookings');

    await request(ctx.app)
      .patch(`/api/admin/bookings/${rows[0].id}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'forged-token-value')
      .send({ status: 'CONTACTED' })
      .expect(403);

    await request(ctx.app)
      .patch(`/api/admin/bookings/${rows[0].id}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ status: 'CONTACTED' })
      .expect(200);
  });
});

describe('authorisation (roles)', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);
  beforeEach(resetData);

  async function bookingId(): Promise<string> {
    await request(ctx.app).post('/api/bookings').send(sampleBooking());
    const { rows } = await db().query('SELECT id::text AS id FROM bookings');
    return rows[0].id;
  }

  it('lets STAFF read and update bookings', async () => {
    const { password } = await createTestUser('STAFF', 'staff@chfr.test');
    const { cookie, csrf } = await signIn(ctx.app, 'staff@chfr.test', password);
    const id = await bookingId();

    await request(ctx.app).get(`/api/admin/bookings/${id}`).set('Cookie', cookie).expect(200);
    await request(ctx.app)
      .patch(`/api/admin/bookings/${id}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .send({ status: 'QUOTED', quoted_price: 180 })
      .expect(200);
  });

  it('blocks STAFF from permanently deleting a booking', async () => {
    const { password } = await createTestUser('STAFF', 'staff@chfr.test');
    const { cookie, csrf } = await signIn(ctx.app, 'staff@chfr.test', password);
    const id = await bookingId();

    const res = await request(ctx.app)
      .delete(`/api/admin/bookings/${id}?permanent=true`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf);

    expect(res.status).toBe(403);
    const { rows } = await db().query('SELECT count(*)::int AS c FROM bookings');
    expect(rows[0].c).toBe(1);
  });

  it('blocks STAFF from the users page', async () => {
    const { password } = await createTestUser('STAFF', 'staff@chfr.test');
    const { cookie } = await signIn(ctx.app, 'staff@chfr.test', password);
    await request(ctx.app).get('/admin/users').set('Cookie', cookie).expect(403);
  });

  it('allows ADMIN to archive and to permanently delete', async () => {
    const { password } = await createTestUser('ADMIN');
    const { cookie, csrf } = await signIn(ctx.app, 'admin@chfr.test', password);
    const id = await bookingId();

    await request(ctx.app)
      .delete(`/api/admin/bookings/${id}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .expect(200);

    // Archive is a soft delete: the row and its history are still there.
    let { rows } = await db().query('SELECT archived_at FROM bookings');
    expect(rows[0].archived_at).toBeTruthy();

    await request(ctx.app)
      .delete(`/api/admin/bookings/${id}?permanent=true`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .expect(200);

    rows = (await db().query('SELECT count(*)::int AS c FROM bookings')).rows;
    expect(rows[0].c).toBe(0);
  });
});

describe('security headers', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);

  it('sets a content security policy and framing protection on the public site', async () => {
    const res = await request(ctx.app).get('/');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('marks admin pages no-store and noindex', async () => {
    const res = await request(ctx.app).get('/admin/login');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-robots-tag']).toContain('noindex');
  });
});
