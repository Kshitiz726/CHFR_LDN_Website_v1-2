import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { emailTransport, isEmailConfigured } from './email/index.js';
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
    return { status: 'NOT_CONFIGURED', detail: 'SMTP_HOST is not set — emails are captured, not delivered' };
  }
  // The SMTP handshake is only performed on request: the dashboard does it,
  // an uptime monitor hitting /api/health every minute should not.
  if (!deep) return { status: 'CONNECTED', detail: `SMTP ${config.SMTP_HOST}:${config.SMTP_PORT}` };

  const started = Date.now();
  return timeBoxed(
    8000,
    async (): Promise<Check> => {
      const res = await emailTransport().verify();
      return res.ok
        ? { status: 'CONNECTED' as const, detail: `SMTP ${config.SMTP_HOST}`, latencyMs: Date.now() - started }
        : { status: 'ERROR' as const, detail: res.error };
    },
    (): Check => ({ status: 'DEGRADED', detail: 'SMTP verification timed out' }),
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
