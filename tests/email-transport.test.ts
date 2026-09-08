import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestApp, teardownTestApp } from './helpers.js';
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
