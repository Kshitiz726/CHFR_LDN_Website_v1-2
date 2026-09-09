import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestApp, teardownTestApp, resetData, type TestContext } from './helpers.js';
import { bootstrapAdminFromEnv } from '../src/auth/bootstrap.js';
import { config } from '../src/config/env.js';
import * as usersRepo from '../src/repositories/users.js';
import { verifyPassword } from '../src/auth/password.js';

/** The env-driven account creation used on hosting plans with no shell. */
function withBootstrapEnv(values: Partial<Record<string, string | undefined>>) {
  const keys = ['ADMIN_BOOTSTRAP_EMAIL', 'ADMIN_BOOTSTRAP_NAME', 'ADMIN_BOOTSTRAP_PASSWORD', 'ADMIN_BOOTSTRAP_ROLE'];
  const previous: Record<string, unknown> = {};
  for (const k of keys) previous[k] = (config as any)[k];
  for (const k of keys) (config as any)[k] = values[k];
  return () => { for (const k of keys) (config as any)[k] = previous[k]; };
}

describe('admin bootstrap from environment', () => {
  let ctx: TestContext;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);
  beforeEach(resetData);

  it('does nothing when the variables are absent', async () => {
    const restore = withBootstrapEnv({});
    const result = await bootstrapAdminFromEnv();
    expect(result.status).toBe('skipped');
    expect(await usersRepo.countUsers()).toBe(0);
    restore();
  });

  it('creates a working ADMIN account, and the password actually signs in', async () => {
    const restore = withBootstrapEnv({
      ADMIN_BOOTSTRAP_EMAIL: 'CHFRLONDON@GMAIL.COM',
      ADMIN_BOOTSTRAP_NAME: 'CHFR Operations',
      ADMIN_BOOTSTRAP_PASSWORD: 'BootstrapPass2026',
    });

    const result = await bootstrapAdminFromEnv();
    expect(result.status).toBe('created');

    const user = await usersRepo.findUserByEmail('chfrlondon@gmail.com');
    expect(user).toBeTruthy();
    expect(user!.role).toBe('ADMIN');
    expect(user!.name).toBe('CHFR Operations');

    // End to end: the credentials work against the real login route.
    const res = await request(ctx.app)
      .post('/admin/login').type('form')
      .send({ email: 'CHFRLONDON@GMAIL.COM', password: 'BootstrapPass2026' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
    restore();
  });

  it('resets an existing account instead of creating a duplicate', async () => {
    let restore = withBootstrapEnv({
      ADMIN_BOOTSTRAP_EMAIL: 'ops@chfrldn.com',
      ADMIN_BOOTSTRAP_PASSWORD: 'FirstPassword2026',
    });
    await bootstrapAdminFromEnv();
    restore();

    restore = withBootstrapEnv({
      ADMIN_BOOTSTRAP_EMAIL: 'ops@chfrldn.com',
      ADMIN_BOOTSTRAP_PASSWORD: 'SecondPassword2026',
    });
    const second = await bootstrapAdminFromEnv();
    expect(second.status).toBe('updated');
    expect(await usersRepo.countUsers()).toBe(1);

    const user = await usersRepo.findUserByEmail('ops@chfrldn.com');
    expect(await verifyPassword('SecondPassword2026', user!.password_hash)).toBe(true);
    expect(await verifyPassword('FirstPassword2026', user!.password_hash)).toBe(false);
    restore();
  });

  it('re-enables an account that had been disabled', async () => {
    let restore = withBootstrapEnv({
      ADMIN_BOOTSTRAP_EMAIL: 'locked@chfrldn.com',
      ADMIN_BOOTSTRAP_PASSWORD: 'RecoverMe2026xy',
    });
    await bootstrapAdminFromEnv();
    restore();

    const user = await usersRepo.findUserByEmail('locked@chfrldn.com');
    await usersRepo.setUserActive(user!.id, false);

    restore = withBootstrapEnv({
      ADMIN_BOOTSTRAP_EMAIL: 'locked@chfrldn.com',
      ADMIN_BOOTSTRAP_PASSWORD: 'RecoverMe2026xy',
    });
    await bootstrapAdminFromEnv();
    restore();

    expect((await usersRepo.findUserById(user!.id))!.active).toBe(true);
  });

  it('refuses a weak password rather than creating a guessable admin', async () => {
    const restore = withBootstrapEnv({
      ADMIN_BOOTSTRAP_EMAIL: 'weak@chfrldn.com',
      ADMIN_BOOTSTRAP_PASSWORD: 'password',
    });
    const result = await bootstrapAdminFromEnv();
    expect(result.status).toBe('rejected');
    expect(await usersRepo.countUsers()).toBe(0);
    restore();
  });

  it('can create a STAFF account when asked', async () => {
    const restore = withBootstrapEnv({
      ADMIN_BOOTSTRAP_EMAIL: 'driver@chfrldn.com',
      ADMIN_BOOTSTRAP_PASSWORD: 'StaffPassword2026',
      ADMIN_BOOTSTRAP_ROLE: 'STAFF',
    });
    await bootstrapAdminFromEnv();
    expect((await usersRepo.findUserByEmail('driver@chfrldn.com'))!.role).toBe('STAFF');
    restore();
  });
});
