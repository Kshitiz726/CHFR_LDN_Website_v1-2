import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { emailTransport, isEmailConfigured, emailProviderName } from './email/index.js';
import { spreadsheetProvider } from './spreadsheet/index.js';
import { whatsAppProvider } from './whatsapp/index.js';

/**
 * System health, used by /api/health and shown on the dashboard.
 *
 * Every check is time-boxed and swallowed: the health endpoint must never hang
 * or throw, because that is exactly when it matters most.
 */

export type CheckStatus =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'NOT_CONFIGURED'
  | 'QR_REQUIRED'
  | 'ERROR';

export interface Check {
  status: CheckStatus;
  detail?: string;
  latencyMs?: number;
}

export interface HealthReport {
  ok: boolean;
  timestamp: string;
  version: string;
  environment: string;
  checks: {
    database: Check;
    email: Check;
    spreadsheet: Check;
    whatsapp: Check;
    application: Check;
  };
}

async function timeBoxed<T>(ms: number, run: () => Promise<T>, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function checkDatabase(): Promise<Check> {
  const started = Date.now();
  return timeBoxed(
    5000,
    async (): Promise<Check> => {
      try {
        await db().query('SELECT 1');
        return { status: 'CONNECTED' as const, latencyMs: Date.now() - started };
      } catch (err) {
        return { status: 'ERROR' as const, detail: err instanceof Error ? err.message : String(err) };
      }
    },
    (): Check => ({ status: 'ERROR', detail: 'Database check timed out' }),
  );
}

async function checkEmail(deep: boolean): Promise<Check> {
  if (!isEmailConfigured()) {
    return {
      status: 'NOT_CONFIGURED',
      detail: 'No RESEND_API_KEY and no SMTP_HOST — emails are captured in memory, not delivered',
    };
  }
  const provider = emailProviderName();
  if (provider === 'resend') {
    if (!deep) return { status: 'CONNECTED', detail: 'Resend (HTTPS)' };
    const started = Date.now();
    return timeBoxed(
      15_000,
      async (): Promise<Check> => {
        const res = await emailTransport().verify();
        return res.ok
          ? { status: 'CONNECTED' as const, detail: 'Resend (HTTPS)', latencyMs: Date.now() - started }
          : { status: 'ERROR' as const, detail: res.error };
      },
      (): Check => ({ status: 'DEGRADED', detail: 'Resend did not respond within 15s' }),
    );
  }
  // The SMTP handshake is only performed on request: the dashboard does it,
  // an uptime monitor hitting /api/health every minute should not.
  if (!deep) return { status: 'CONNECTED', detail: `SMTP ${config.SMTP_HOST}:${config.SMTP_PORT}` };

  const started = Date.now();
  // The budget must exceed the transport's own connectionTimeout (15s),
  // otherwise a slow-but-working handshake is reported as degraded and a
  // genuinely working mail setup looks broken.
  return timeBoxed(
    20_000,
    async (): Promise<Check> => {
      const res = await emailTransport().verify();
      if (res.ok) {
        return { status: 'CONNECTED' as const, detail: `SMTP ${config.SMTP_HOST}`, latencyMs: Date.now() - started };
      }
      return { status: 'ERROR' as const, detail: describeSmtpError(res.error) };
    },
    (): Check => ({
      status: 'DEGRADED',
      detail:
        `No reply from ${config.SMTP_HOST}:${config.SMTP_PORT} within 20s. ` +
        'Sending may still work — send a test booking to confirm. If that also fails, ' +
        'the host is likely blocking outbound SMTP on this port.',
    }),
  );
}

async function checkSpreadsheet(deep: boolean): Promise<Check> {
  const provider = spreadsheetProvider();
  if (!provider.configured) {
    return { status: 'NOT_CONFIGURED', detail: 'No live spreadsheet — dashboard export is available' };
  }
  if (!deep) return { status: 'CONNECTED', detail: provider.name };

  return timeBoxed(
    8000,
    async (): Promise<Check> => {
      const res = await provider.healthCheck();
      return res.ok
        ? { status: 'CONNECTED' as const, detail: provider.name }
        : { status: 'ERROR' as const, detail: res.error };
    },
    (): Check => ({ status: 'DEGRADED', detail: 'Spreadsheet check timed out' }),
  );
}

async function checkWhatsApp(): Promise<Check> {
  const provider = whatsAppProvider();
  if (!provider.configured) {
    return { status: 'NOT_CONFIGURED', detail: 'WHATSAPP_ENABLED is off or OpenWA is not configured' };
  }

  return timeBoxed(
    8000,
    async (): Promise<Check> => {
      const status = await provider.status();
      if (status.state === 'CONNECTED') return { status: 'CONNECTED' as const, detail: `Session ${status.sessionId}` };
      if (status.state === 'QR_REQUIRED') return { status: 'QR_REQUIRED' as const, detail: 'Waiting for QR scan' };
      if (status.state === 'NOT_CONFIGURED') return { status: 'NOT_CONFIGURED' as const, detail: status.detail };
      return { status: 'DISCONNECTED' as const, detail: status.error ?? status.detail };
    },
    (): Check => ({ status: 'DISCONNECTED', detail: 'OpenWA did not respond in time' }),
  );
}

/**
 * Turns an SMTP failure into something an operator can act on. The distinction
 * that matters: credentials rejected (fix the App Password) versus never
 * reached the server (network, or the host blocks the port).
 */
function describeSmtpError(error: string | undefined): string {
  const raw = error ?? 'Unknown SMTP error';
  const e = raw.toLowerCase();

  if (e.includes('invalid login') || e.includes('username and password not accepted') || e.includes('535')) {
    return `Credentials rejected by ${config.SMTP_HOST}. Gmail requires a 16-character App Password, not the account password. (${raw.slice(0, 120)})`;
  }
  if (e.includes('etimedout') || e.includes('timeout') || e.includes('econnrefused') || e.includes('ehostunreach')) {
    return `Could not reach ${config.SMTP_HOST}:${config.SMTP_PORT}. The host may block outbound SMTP on this port. (${raw.slice(0, 120)})`;
  }
  if (e.includes('enotfound') || e.includes('eai_again')) {
    return `Could not resolve ${config.SMTP_HOST}. Check SMTP_HOST for typos. (${raw.slice(0, 120)})`;
  }
  if (e.includes('self signed') || e.includes('certificate')) {
    return `TLS problem talking to ${config.SMTP_HOST}. (${raw.slice(0, 120)})`;
  }
  return raw.slice(0, 200);
}

export async function healthReport(options: { deep?: boolean } = {}): Promise<HealthReport> {
  const deep = options.deep ?? false;

  const [database, email, spreadsheet, whatsapp] = await Promise.all([
    checkDatabase(),
    checkEmail(deep),
    checkSpreadsheet(deep),
    checkWhatsApp(),
  ]);

  // Only the database can make the application unhealthy. Every other channel
  // is optional by design — a booking is never lost because one is down.
  const ok = database.status === 'CONNECTED';

  return {
    ok,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '2.0.0',
    environment: config.NODE_ENV,
    checks: {
      database,
      email,
      spreadsheet,
      whatsapp,
      application: ok
        ? { status: 'HEALTHY', detail: `uptime ${Math.round(process.uptime())}s` }
        : { status: 'DEGRADED', detail: 'Database unavailable' },
    },
  };
}
