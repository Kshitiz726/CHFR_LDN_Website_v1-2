import type { Express } from 'express';
import request from 'supertest';
import { initDatabase, closeDatabase, db, __setDatabaseForTests } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { clearRefOptionCache } from '../src/domain/refOptions.js';
import { createApp } from '../src/http/app.js';
import { hashPassword } from '../src/auth/password.js';
import * as usersRepo from '../src/repositories/users.js';
import { MemoryTransport, setEmailTransport } from '../src/services/email/index.js';
import { setWhatsAppProvider } from '../src/services/whatsapp/index.js';
import { setSpreadsheetProvider } from '../src/services/spreadsheet/index.js';
import type { WhatsAppProvider, WhatsAppSendResult, WhatsAppStatus } from '../src/services/whatsapp/provider.js';
import type { SpreadsheetProvider, SyncResult } from '../src/services/spreadsheet/provider.js';
import { todayIso, addDaysIso } from '../src/utils/dates.js';

/** A WhatsApp provider whose behaviour each test controls. */
export class FakeWhatsApp implements WhatsAppProvider {
  readonly name = 'fake';
  configured = true;
  shouldFail = false;
  failureMessage = 'OpenWA unavailable';
  sent: Array<{ to: string; body: string }> = [];

  async sendText(to: string, body: string): Promise<WhatsAppSendResult> {
    if (this.shouldFail) return { ok: false, error: this.failureMessage };
    this.sent.push({ to, body });
    return { ok: true, messageId: `wa-${this.sent.length}` };
  }

  async status(): Promise<WhatsAppStatus> {
    return this.shouldFail
      ? { state: 'DISCONNECTED', error: this.failureMessage }
      : { state: 'CONNECTED', sessionId: 'CHFR' };
  }

  async start() { return { ok: !this.shouldFail }; }
  async stop() { return { ok: true }; }
  async qr() { return { ok: true, qr: 'fake-qr' }; }
}

/** A spreadsheet provider whose behaviour each test controls. */
export class FakeSpreadsheet implements SpreadsheetProvider {
  readonly name = 'fake-sheet';
  configured = true;
  shouldFail = false;
  rows = new Map<string, unknown[]>();

  async upsertBooking(booking: any, refs: any): Promise<SyncResult> {
    if (this.shouldFail) return { ok: false, error: 'Google Sheets unavailable' };
    const { bookingToRow } = await import('../src/services/spreadsheet/columns.js');
    const isNew = !this.rows.has(booking.booking_reference);
    this.rows.set(booking.booking_reference, bookingToRow(booking, refs));
    return { ok: true, rowNumber: isNew ? this.rows.size + 1 : Array.from(this.rows.keys()).indexOf(booking.booking_reference) + 2 };
  }

  async healthCheck() { return { ok: !this.shouldFail }; }
}

/** An email transport whose behaviour each test controls. */
export class FakeEmail extends MemoryTransport {
  shouldFail = false;
  failureMessage = 'SMTP connection refused';

  override async send(to: string, content: any) {
    if (this.shouldFail) return { ok: false, error: this.failureMessage };
    return super.send(to, content);
  }
}

export interface TestContext {
  app: Express;
  email: FakeEmail;
  whatsapp: FakeWhatsApp;
  sheet: FakeSpreadsheet;
}

export async function setupTestApp(): Promise<TestContext> {
  __setDatabaseForTests(undefined);
  await initDatabase();
  await runMigrations();
  clearRefOptionCache();

  const email = new FakeEmail();
  const whatsapp = new FakeWhatsApp();
  const sheet = new FakeSpreadsheet();
  setEmailTransport(email);
  setWhatsAppProvider(whatsapp);
  setSpreadsheetProvider(sheet);

  return { app: createApp(), email, whatsapp, sheet };
}

export async function teardownTestApp(): Promise<void> {
  setEmailTransport(undefined);
  setWhatsAppProvider(undefined);
  setSpreadsheetProvider(undefined);
  clearRefOptionCache();
  await closeDatabase();
  __setDatabaseForTests(undefined);
}

export async function resetData(): Promise<void> {
  await db().query(
    `TRUNCATE booking_events, notification_logs, whatsapp_messages, email_logs,
              idempotency_keys, rate_limits, sessions, bookings, users
     RESTART IDENTITY CASCADE`,
  );
  await db().query('DELETE FROM booking_sequences');
  clearRefOptionCache();
}

export async function createTestUser(
  role: 'ADMIN' | 'STAFF' = 'ADMIN',
  email = `${role.toLowerCase()}@chfr.test`,
  password = 'CorrectHorse123!',
) {
  const user = await usersRepo.createUser({
    email,
    name: role === 'ADMIN' ? 'Test Admin' : 'Test Staff',
    role,
    password_hash: await hashPassword(password),
  });
  return { user, password };
}

/** Signs in over HTTP and returns the cookie plus the session's CSRF token. */
export async function signIn(app: Express, email: string, password: string) {
  const res = await request(app).post('/admin/login').type('form').send({ email, password });
  const cookie = (res.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? '';
  if (!cookie) throw new Error('Sign-in did not set a session cookie');

  const { findSession } = await import('../src/auth/session.js');
  const token = cookie.split('=')[1] ?? '';
  const session = await findSession(decodeURIComponent(token));
  return { cookie, csrf: session!.csrfToken };
}

/** The exact submission described in the brief's end-to-end scenario. */
export function sampleBooking(overrides: Record<string, unknown> = {}) {
  return {
    full_name: 'John Smith',
    mobile: '+447700900000',
    email: 'john@example.com',
    pickup_location: 'Heathrow Terminal 5',
    destination: 'The Savoy, London',
    journey_date: addDaysIso(todayIso(), 7),
    pickup_time: '14:30',
    passengers: 2,
    luggage: 'TWO',
    journey_type: 'AIRPORT_TRANSFER',
    preferred_vehicle: 'MERCEDES_S_CLASS',
    flight_number: 'BA249',
    special_requests: 'Meet inside arrivals.',
    ...overrides,
  };
}
