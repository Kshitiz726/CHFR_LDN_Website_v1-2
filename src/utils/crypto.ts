import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.js';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * IP addresses are personal data under UK GDPR, so we never store them. A
 * salted hash is enough to spot abuse patterns without retaining the address.
 */
export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${config.ipHashSalt}:${ip}`).digest('hex').slice(0, 32);
}

/** Constant-time string comparison for tokens (CSRF, session). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a ?? '', 'utf8');
  const bufB = Buffer.from(b ?? '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Fingerprint of the journey itself. Used as a second line of defence against
 * duplicates when the browser did not send an idempotency key (e.g. the user
 * refreshed and re-posted).
 */
export function bookingDedupeHash(parts: {
  email: string;
  mobile: string;
  pickup_location: string;
  destination: string;
  journey_date: string;
  pickup_time: string;
}): string {
  const canonical = [
    parts.email.trim().toLowerCase(),
    parts.mobile.trim(),
    parts.pickup_location.trim().toLowerCase(),
    parts.destination.trim().toLowerCase(),
    parts.journey_date,
    parts.pickup_time,
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}
