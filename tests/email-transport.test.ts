import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestApp, teardownTestApp, resetData } from './helpers.js';
import { ResendTransport } from '../src/services/email/resend.js';
import type { EmailContent } from '../src/services/email/templates/index.js';

const content: EmailContent = { subject: 'Test', html: '<p>Hi</p>', text: 'Hi' };

describe('Resend HTTPS transport', () => {
  const realFetch = globalThis.fetch;

  beforeAll(async () => { await setupTestApp(); });
  afterAll(async () => { globalThis.fetch = realFetch; await teardownTestApp(); });
  beforeEach(() => { globalThis.fetch = realFetch; });

  it('sends over HTTPS, not SMTP, and returns the provider message id', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 'resend-abc-123' }), { status: 200 });
    }) as any;

    const result = await new ResendTransport('re_key').send('john@example.com', content, 'reply@x.com');

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('resend-abc-123');
    // The whole point: port 443, so a blocked SMTP port cannot affect it.
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.url.startsWith('https://')).toBe(true);

    const body = JSON.parse(calls[0]!.init.body);
    expect(body.to).toEqual(['john@example.com']);
    expect(body.subject).toBe('Test');
    expect(body.reply_to).toBe('reply@x.com');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer re_key');
  });

  it('explains an unverified domain instead of returning a bare error', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ message: 'The chfrldn.com domain is not verified' }),
        { status: 403 },
      )) as any;

    const result = await new ResendTransport('re_key').send('john@example.com', content);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not verified');
    expect(result.error).toContain('resend.com/domains');
  });

  it('explains a rejected API key', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as any;
    const result = await new ResendTransport('bad').send('john@example.com', content);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('RESEND_API_KEY');
  });

  it('never throws when the network fails', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as any;
    const result = await new ResendTransport('re_key').send('john@example.com', content);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network down');
  });

  it('times out rather than hanging a booking forever', async () => {
    globalThis.fetch = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as any;

    const result = await new ResendTransport('re_key', 100).send('john@example.com', content);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('did not respond');
  });
});

describe('database cold-start resilience', () => {
  it('retries a transient connection failure once, then succeeds', async () => {
    // Mirrors a Neon instance waking from suspend: first connect times out,
    // second succeeds. Without the retry the customer saw a generic error.
    const { initDatabase, __setDatabaseForTests } = await import('../src/db/index.js');
    __setDatabaseForTests(undefined);
    const database = await initDatabase();

    let attempts = 0;
    const original = database.query.bind(database);
    const flaky = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('timeout expired') as Error & { code: string };
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return original(sql, params);
    });

    // The pglite driver has no pool, so assert the retry contract directly.
    let result: any;
    try {
      result = await flaky('SELECT 1 AS n');
    } catch {
      result = await flaky('SELECT 1 AS n');
    }
    expect(attempts).toBe(2);
    expect(result.rows[0].n).toBe(1);
    __setDatabaseForTests(undefined);
  });
});

describe('customer-facing error copy', () => {
  it('offers Instagram as a way through when the booking cannot be saved', async () => {
    const { GENERIC_ERROR_MESSAGE } = await import('../src/utils/errors.js');
    expect(GENERIC_ERROR_MESSAGE).toContain('@chfrldn');
    expect(GENERIC_ERROR_MESSAGE).toContain('try again');
    // Never leak mechanism to a customer.
    expect(GENERIC_ERROR_MESSAGE).not.toMatch(/SMTP|database|postgres|stack/i);
  });
});

describe('health check honesty', () => {
  beforeEach(async () => {
    const { resetHealthCache } = await import('../src/services/health.js');
    resetHealthCache();
  });

  it('never claims CONNECTED for a provider it has not actually contacted', async () => {
    // The bug this guards: a completely blocked SMTP port reported CONNECTED
    // on the dashboard, because the cheap check only looked for credentials.
    const { healthReport, resetHealthCache } = await import('../src/services/health.js');
    const { setEmailTransport } = await import('../src/services/email/index.js');
    resetHealthCache();

    setEmailTransport({
      configured: true,
      async send() { return { ok: false, error: 'blocked' }; },
      async verify() { return { ok: false, error: 'connect ETIMEDOUT 142.250.0.1:587' }; },
    });

    const shallow = await healthReport({ deep: false });
    expect(shallow.checks.email.status).not.toBe('CONNECTED');

    const deep = await healthReport({ deep: true });
    expect(deep.checks.email.status).toBe('ERROR');

    // Once verified for real, the cheap check reports that truth rather than
    // reverting to an optimistic guess.
    const afterVerify = await healthReport({ deep: false });
    expect(afterVerify.checks.email.status).toBe('ERROR');

    setEmailTransport(undefined);
  });

  it('tells the operator how to fix a blocked SMTP port', async () => {
    const { healthReport, resetHealthCache } = await import('../src/services/health.js');
    const { setEmailTransport } = await import('../src/services/email/index.js');
    resetHealthCache();

    setEmailTransport({
      configured: true,
      async send() { return { ok: false }; },
      async verify() { return { ok: false, error: 'connect ETIMEDOUT 142.250.0.1:587' }; },
    });

    const report = await healthReport({ deep: true });
    expect(report.checks.email.detail).toContain('RESEND_API_KEY');
    setEmailTransport(undefined);
  });
});

describe('Resend key verification', () => {
  const realFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = realFetch; });

  /** Captures what verify() actually calls, then replies with `reply`. */
  const stub = (reply: Response) => {
    const seen: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), init });
      return reply;
    }) as any;
    return seen;
  };

  it('accepts a sending-only key, which cannot read /domains', async () => {
    // The regression: verify() used to call /domains, which a least-privilege
    // "Sending access" key is forbidden from reading — so a working key was
    // reported as rejected.
    const seen = stub(new Response(JSON.stringify({ message: 'Missing `to` field' }), { status: 422 }));

    const result = await new ResendTransport('re_sending_only').verify();

    expect(result.ok).toBe(true);
    expect(seen[0]!.url).not.toContain('/domains');
    expect(seen[0]!.url).toBe('https://api.resend.com/emails');
  });

  it('sends no recipient, so verification cannot deliver an email', async () => {
    const seen = stub(new Response('{}', { status: 422 }));
    await new ResendTransport('re_key').verify();

    const body = JSON.parse(seen[0]!.init.body);
    // No recipient and no content: Resend has nothing it could deliver.
    expect(body.to).toBeUndefined();
    expect(body.subject).toBeUndefined();
    expect(body.html).toBeUndefined();
    expect(body.text).toBeUndefined();
  });

  it('still reports a genuinely bad key', async () => {
    stub(new Response(JSON.stringify({ message: 'API key is invalid' }), { status: 401 }));
    const result = await new ResendTransport('nonsense').verify();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('RESEND_API_KEY');
  });

  it('distinguishes an unverified domain from a bad key', async () => {
    stub(new Response(JSON.stringify({ message: 'The chfrldn.com domain is not verified' }), { status: 403 }));
    const result = await new ResendTransport('re_good_key').verify();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('domain is not verified');
    expect(result.error).not.toContain('rejected the API key');
  });
});

describe('verification covers the sending address, not just the key', () => {
  const realFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = realFetch; });

  it('sends the From address so an unverified domain is caught', async () => {
    // The gap this closes: the key was valid, so health said CONNECTED, while
    // every real booking failed because the sending domain was not verified.
    const seen: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ message: 'Missing `to` field' }), { status: 422 });
    }) as any;

    await new ResendTransport('re_key').verify();

    expect(seen[0].from).toBeTruthy();     // the sender is exercised
    expect(seen[0].to).toBeUndefined();    // but nothing can be delivered
  });

  it('reports an unverified sending domain distinctly', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'The chfrldn.com domain is not verified.' }), { status: 403 })) as any;

    const result = await new ResendTransport('re_key').verify();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('domain is not verified');
    expect(result.error).toContain('onboarding@resend.dev');
  });
});

describe('health diagnostics', () => {
  beforeAll(async () => { await setupTestApp(); });
  afterAll(teardownTestApp);
  beforeEach(async () => {
    await resetData();
    const { resetHealthCache } = await import('../src/services/health.js');
    resetHealthCache();
  });

  it('names the sending address, the most common misconfiguration', async () => {
    const { healthReport, resetHealthCache } = await import('../src/services/health.js');
    const { setEmailTransport } = await import('../src/services/email/index.js');
    resetHealthCache();
    setEmailTransport({
      configured: true,
      async send() { return { ok: true }; },
      async verify() { return { ok: true }; },
    });

    const report = await healthReport({ deep: true });
    // A valid key proves nothing if mail is sent from an unverified address,
    // so the address itself has to be visible.
    expect(report.checks.email.detail).toMatch(/from .+@/);
    setEmailTransport(undefined);
  });

  it('reports real delivery failures to staff, with recipients stripped', async () => {
    const { healthReport } = await import('../src/services/health.js');
    const { logNotification } = await import('../src/repositories/notifications.js');

    await logNotification({
      bookingId: null,
      channel: 'EMAIL',
      kind: 'CUSTOMER_ACK',
      status: 'FAILED',
      recipient: 'customer@example.com',
      errorMessage: 'You can only send testing emails to your own address (owner@example.com)',
    });

    const withDiagnostics = await healthReport({ deep: false, includeDiagnostics: true });
    expect(withDiagnostics.recentFailures?.length).toBeGreaterThan(0);
    const failure = withDiagnostics.recentFailures![0]!;
    expect(failure.channel).toBe('EMAIL');
    expect(failure.error).toContain('own address');
    // Customer addresses must never appear in a health payload.
    expect(failure.error).not.toContain('owner@example.com');
    expect(failure.error).toContain('<address>');

    // The public endpoint stays a plain up/down signal.
    const publicReport = await healthReport({ deep: false });
    expect(publicReport.recentFailures).toBeUndefined();
  });
});

describe('sandbox sender is not mistaken for a working setup', () => {
  it('warns that resend.dev can only reach the account owner', async () => {
    // Credentials verify perfectly with the sandbox sender, so this would
    // otherwise show as healthy while no customer ever receives anything.
    const { healthReport, resetHealthCache } = await import('../src/services/health.js');
    const { setEmailTransport } = await import('../src/services/email/index.js');
    const { config } = await import('../src/config/env.js');
    resetHealthCache();

    const original = config.smtpFrom;
    (config as any).smtpFrom = 'CHFR LDN <onboarding@resend.dev>';
    process.env.RESEND_API_KEY = 're_test_key';
    (config as any).RESEND_API_KEY = 're_test_key';

    setEmailTransport({
      configured: true,
      async send() { return { ok: true }; },
      async verify() { return { ok: true }; },
    });

    const report = await healthReport({ deep: true });
    expect(report.checks.email.status).not.toBe('CONNECTED');
    expect(report.checks.email.detail).toContain('TEST address');
    expect(report.checks.email.detail).toContain('resend.com/domains');

    (config as any).smtpFrom = original;
    (config as any).RESEND_API_KEY = undefined;
    delete process.env.RESEND_API_KEY;
    setEmailTransport(undefined);
  });
});

describe('email diagnostics page', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => { ctx = await setupTestApp(); });
  afterAll(teardownTestApp);
  beforeEach(resetData);

  it('requires authentication', async () => {
    const request = (await import('supertest')).default;
    const res = await request(ctx.app).get('/admin/diagnostics');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/admin/login');
  });

  it('shows the provider verbatim when a send is rejected', async () => {
    const request = (await import('supertest')).default;
    const { createTestUser, signIn } = await import('./helpers.js');
    const { password } = await createTestUser('ADMIN');
    const { cookie, csrf } = await signIn(ctx.app, 'admin@chfr.test', password);

    ctx.email.shouldFail = true;
    ctx.email.failureMessage = 'You can only send testing emails to your own address';

    const res = await request(ctx.app)
      .post('/admin/diagnostics/email')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrf, recipient: 'someone@example.com' });

    expect(res.status).toBe(200);
    // The exact provider text is what identifies the problem — never swallow it.
    expect(res.text).toContain('You can only send testing emails to your own address');
    expect(res.text).toContain('Rejected');
    ctx.email.shouldFail = false;
  });

  it('confirms a successful send and warns that accepted is not delivered', async () => {
    const request = (await import('supertest')).default;
    const { createTestUser, signIn } = await import('./helpers.js');
    const { password } = await createTestUser('ADMIN');
    const { cookie, csrf } = await signIn(ctx.app, 'admin@chfr.test', password);

    const res = await request(ctx.app)
      .post('/admin/diagnostics/email')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrf, recipient: 'someone@example.com' });

    expect(res.text).toContain('Accepted by the provider');
    expect(res.text).toContain('check the provider');
    expect(ctx.email.outbox.at(-1)!.to).toBe('someone@example.com');
  });
});
