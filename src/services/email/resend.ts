import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { EmailContent } from './templates/index.js';
import type { EmailTransport, SendResult } from './index.js';

/**
 * Email over HTTPS via Resend (https://resend.com).
 *
 * This exists because most managed hosts — Render's free and starter plans
 * included — block outbound SMTP on ports 25, 465 and 587 to prevent spam.
 * A blocked port shows up as a connection timeout, not a refusal, so it looks
 * like a hang. Sending over 443 sidesteps the problem entirely and is faster,
 * because there is no multi-round-trip SMTP handshake.
 */
export class ResendTransport implements EmailTransport {
  readonly configured = true;
  private readonly endpoint = 'https://api.resend.com/emails';

  constructor(
    private readonly apiKey = config.RESEND_API_KEY,
    private readonly timeoutMs = 15_000,
  ) {}

  async send(to: string, content: EmailContent, replyTo?: string): Promise<SendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.smtpFrom,
          to: [to],
          subject: content.subject,
          html: content.html,
          text: content.text,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
        signal: controller.signal,
      });

      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { message: text.slice(0, 200) };
      }

      if (!res.ok) {
        return { ok: false, error: describeResendError(res.status, data) };
      }

      return { ok: true, messageId: data?.id ? String(data.id) : undefined };
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `Resend did not respond within ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      logger.error({ to, subject: content.subject, error: message }, 'Resend send failed');
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Proves the API key works, without sending anything.
   *
   * Deliberately does NOT use /domains: that needs domain-read permission,
   * which a "Sending access" key — the correct, least-privilege key for this
   * app — does not have. Checking it there reported a perfectly good key as
   * rejected.
   *
   * Instead it posts an intentionally invalid payload to the send endpoint.
   * Resend authenticates before it validates, so the response separates the
   * two cleanly: 401/403 means the key is bad, while a validation error means
   * the key is fine. No recipient is supplied, so no email can be sent.
   */
  async verify(): Promise<{ ok: boolean; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        const text = await res.text().catch(() => '');
        // A 403 can also mean "domain not verified" rather than a bad key.
        if (/not verified|domain/i.test(text)) {
          return {
            ok: false,
            error:
              'API key works, but the sending domain is not verified. Verify it at ' +
              'https://resend.com/domains, or set SMTP_FROM to onboarding@resend.dev for testing.',
          };
        }
        return {
          ok: false,
          error:
            'Resend rejected the API key. Check RESEND_API_KEY — it should start with "re_" ' +
            'and have Sending access.',
        };
      }

      // 4xx validation (no recipient, no subject) means authentication passed.
      if (res.status === 422 || res.status === 400 || res.ok) return { ok: true };

      return { ok: false, error: `Resend returned an unexpected ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error && err.name === 'AbortError'
            ? 'Resend did not respond within 10s'
            : err instanceof Error
              ? err.message
              : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Resend's most common rejections, translated into something actionable. */
function describeResendError(status: number, data: any): string {
  const raw = String(data?.message ?? data?.name ?? `HTTP ${status}`);
  const lower = raw.toLowerCase();

  // Message content is inspected before status, because Resend returns 403 for
  // an unverified domain as well as for a bad key — and telling an operator to
  // check their API key when the key is fine sends them down the wrong path.
  if (lower.includes('domain is not verified') || lower.includes('not verified')) {
    return (
      `The sending domain in SMTP_FROM is not verified in Resend, so it can only ` +
      `send to your own account address. Verify the domain at ` +
      `https://resend.com/domains, or set SMTP_FROM to onboarding@resend.dev for testing. (${raw.slice(0, 120)})`
    );
  }
  if (lower.includes('you can only send testing emails to your own email')) {
    return (
      `Resend is in testing mode: an unverified domain can only email your own ` +
      `account address. Verify chfrldn.com at https://resend.com/domains to email customers. (${raw.slice(0, 120)})`
    );
  }
  if (status === 401 || status === 403) {
    return `Resend rejected the API key. Check RESEND_API_KEY. (${raw.slice(0, 120)})`;
  }
  if (status === 429) {
    return `Resend rate limit reached. (${raw.slice(0, 120)})`;
  }
  return raw.slice(0, 200);
}
