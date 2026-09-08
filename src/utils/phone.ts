import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Normalise a mobile number to E.164. Numbers typed without a country code are
 * interpreted as UK, which is what almost every CHFR customer will enter.
 *
 * The bar is "possible" rather than "valid". libphonenumber's strict validity
 * check rejects whole ranges that are perfectly dialable — Ofcom's reserved
 * blocks, and any range newer than the bundled metadata. On a lead form,
 * turning away a real customer because of stale metadata is far worse than
 * accepting a number a concierge will ring anyway, so we require a correct
 * country code and a plausible length and leave it there.
 */
export function normalisePhone(input: string, defaultCountry: 'GB' = 'GB'): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = parsePhoneNumberFromString(raw, defaultCountry);
    if (!parsed || !parsed.isPossible()) return null;
    return parsed.number; // E.164, e.g. +447700900000
  } catch {
    return null;
  }
}

export function isValidPhone(input: string, defaultCountry: 'GB' = 'GB'): boolean {
  return normalisePhone(input, defaultCountry) !== null;
}

/** OpenWA / WhatsApp chat id: E.164 without the leading '+', suffixed @c.us */
export function toWhatsAppChatId(e164: string): string | null {
  const digits = (e164 ?? '').replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `${digits}@c.us`;
}
