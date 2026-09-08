import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

/**
 * Cloudflare Turnstile verification. Optional — when no secret is configured
 * the check is skipped entirely so the form is not blocked, and the honeypot
 * plus rate limiting remain in place.
 */
export async function verifyTurnstile(token: string | undefined, ip?: string): Promise<{ ok: boolean; reason?: string }> {
  if (!config.TURNSTILE_SECRET_KEY) return { ok: true };
  if (!token) return { ok: false, reason: 'missing-token' };

  try {
    const body = new URLSearchParams({ secret: config.TURNSTILE_SECRET_KEY, response: token });
    if (ip) body.set('remoteip', ip);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (data.success) return { ok: true };
    return { ok: false, reason: (data['error-codes'] ?? ['verification-failed']).join(',') };
  } catch (err) {
    // If Cloudflare is unreachable we let the booking through rather than
    // losing a customer — the other anti-spam layers still apply.
    logger.warn({ err }, 'Turnstile verification unavailable — allowing submission');
    return { ok: true };
  }
}

export const turnstileEnabled = (): boolean => Boolean(config.TURNSTILE_SECRET_KEY && config.TURNSTILE_SITE_KEY);
