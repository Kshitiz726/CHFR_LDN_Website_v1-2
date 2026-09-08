import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestApp, teardownTestApp } from './helpers.js';
import { validatePublicBooking } from '../src/validation/booking.js';
import { normalisePhone, toWhatsAppChatId } from '../src/utils/phone.js';
import { todayIso, addDaysIso } from '../src/utils/dates.js';
import { sampleBooking } from './helpers.js';

describe('booking validation', () => {
  beforeAll(async () => { await setupTestApp(); });
  afterAll(teardownTestApp);

  it('accepts a complete, valid submission', async () => {
    const result = await validatePublicBooking(sampleBooking());
    expect(result.ok).toBe(true);
    expect(result.value?.mobile).toBe('+447700900000');
    expect(result.value?.flight_number).toBe('BA249');
  });

  it('requires a name, email, pickup and destination', async () => {
    const result = await validatePublicBooking(
      sampleBooking({ full_name: '', email: 'not-an-email', pickup_location: '', destination: '' }),
    );
    expect(result.ok).toBe(false);
    const fields = result.issues.map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['full_name', 'email', 'pickup_location', 'destination']));
  });

  it('rejects an invalid mobile number', async () => {
    const result = await validatePublicBooking(sampleBooking({ mobile: '12345' }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === 'mobile')).toBe(true);
  });

  it('normalises a UK number typed without a country code', async () => {
    const result = await validatePublicBooking(sampleBooking({ mobile: '07700 900000' }));
    expect(result.ok).toBe(true);
    expect(result.value?.mobile).toBe('+447700900000');
  });

  it('rejects a journey date in the past', async () => {
    const result = await validatePublicBooking(sampleBooking({ journey_date: addDaysIso(todayIso(), -1) }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === 'journey_date')).toBe(true);
  });

  it('rejects fewer than one passenger and non-integers', async () => {
    expect((await validatePublicBooking(sampleBooking({ passengers: 0 }))).ok).toBe(false);
    expect((await validatePublicBooking(sampleBooking({ passengers: 2.5 }))).ok).toBe(false);
  });

  it('rejects values outside the allowed enums', async () => {
    for (const patch of [
      { journey_type: 'HELICOPTER' },
      { preferred_vehicle: 'SUBMARINE' },
      { luggage: 'A_LOT' },
    ]) {
      const result = await validatePublicBooking(sampleBooking(patch));
      expect(result.ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it('rejects unexpected fields rather than ignoring them', async () => {
    const result = await validatePublicBooking(sampleBooking({ status: 'CONFIRMED', quoted_price: 1 }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('Unexpected'))).toBe(true);
  });

  it('caps the length of free text', async () => {
    const result = await validatePublicBooking(sampleBooking({ special_requests: 'x'.repeat(2001) }));
    expect(result.ok).toBe(false);
  });

  it('builds a WhatsApp chat id from an E.164 number', () => {
    expect(toWhatsAppChatId('+447700900000')).toBe('447700900000@c.us');
    expect(toWhatsAppChatId('nonsense')).toBeNull();
    expect(normalisePhone('not a phone')).toBeNull();
  });
});
