import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads a local .env file into process.env.
 *
 * Real environment variables always win, so a deployment's configuration can
 * never be overridden by a stray file, and the test-suite's own settings stay
 * authoritative. Implemented here rather than via a dependency because the
 * format we need is a handful of KEY=value lines.
 */
function loadDotEnvFile(path = resolve(process.cwd(), '.env')): void {
  // The test-suite sets everything it needs explicitly; reading a developer's
  // .env there would make test runs depend on the machine.
  if (process.env.NODE_ENV === 'test') return;

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return; // No .env is normal in production.
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key in process.env) continue; // never override a real variable

    let value = withoutExport.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) {
      value = value.slice(1, -1);
      // Only double quotes get escape handling, matching common .env behaviour.
      if (withoutExport[eq + 1] === '"') value = value.replace(/\\n/g, '\n');
    }
    process.env[key] = value;
  }
}

loadDotEnvFile();


/**
 * Central, validated configuration. Nothing else in the app reads process.env
 * directly, so every secret has exactly one place it can enter the system.
 */

const bool = (def: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),
  APP_URL: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool(false),

  // Database
  DATABASE_URL: optStr,
  DATABASE_SSL: bool(false),
  DB_DRIVER: z.enum(['pg', 'pglite']).default('pg'),
  // Generous by default: serverless Postgres needs time to wake from suspend.
  DB_CONNECT_TIMEOUT_MS: int(30_000),

  // Security
  ADMIN_SESSION_SECRET: optStr,
  SESSION_TTL_HOURS: int(12),
  IP_HASH_SALT: optStr,

  // Email
  ADMIN_EMAIL: z.string().default('CHFRLONDON@GMAIL.COM'),
  // 'auto' prefers Resend when a key is present, then SMTP. Many managed hosts
  // block outbound SMTP ports, so HTTPS delivery is the safer default.
  EMAIL_PROVIDER: z.enum(['auto', 'smtp', 'resend']).default('auto'),
  RESEND_API_KEY: optStr,
  SMTP_HOST: optStr,
  SMTP_PORT: int(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: optStr,
  SMTP_PASSWORD: optStr,
  SMTP_FROM: optStr,
  EMAIL_ENABLED: bool(true),

  // WhatsApp / OpenWA
  WHATSAPP_ENABLED: bool(false),
  OPENWA_BASE_URL: optStr,
  OPENWA_API_KEY: optStr,
  OPENWA_SESSION_ID: optStr,
  OPENWA_TIMEOUT_MS: int(15_000),
  CHFR_WHATSAPP_NUMBER: optStr,

  // Spreadsheet
  SPREADSHEET_PROVIDER: z.enum(['none', 'google']).default('none'),
  GOOGLE_SHEETS_ID: optStr,
  GOOGLE_SHEETS_TAB: z.string().default('Bookings'),
  GOOGLE_SERVICE_ACCOUNT_JSON: optStr,

  // Anti-spam
  TURNSTILE_SECRET_KEY: optStr,
  TURNSTILE_SITE_KEY: optStr,
  BOOKING_RATE_LIMIT_MAX: int(6),
  BOOKING_RATE_LIMIT_WINDOW_MIN: int(60),
  LOGIN_RATE_LIMIT_MAX: int(8),
  LOGIN_RATE_LIMIT_WINDOW_MIN: int(15),

  // Business
  DEFAULT_CURRENCY: z.string().default('GBP'),
  BUSINESS_TIMEZONE: z.string().default('Europe/London'),
  CUSTOMER_UPDATE_EMAILS_ENABLED: bool(true),

  // First-run / recovery account, applied at boot. Intended for hosting plans
  // with no shell access. Remove ADMIN_BOOTSTRAP_PASSWORD once it has applied.
  ADMIN_BOOTSTRAP_EMAIL: optStr,
  ADMIN_BOOTSTRAP_NAME: optStr,
  ADMIN_BOOTSTRAP_PASSWORD: optStr,
  ADMIN_BOOTSTRAP_ROLE: z.enum(['ADMIN', 'STAFF']).default('ADMIN'),
});

export type AppConfig = z.infer<typeof schema> & {
  isProduction: boolean;
  isTest: boolean;
  sessionSecret: string;
  ipHashSalt: string;
  smtpFrom: string;
};

function build(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${detail}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction) {
    const missing: string[] = [];
    if (!env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!env.ADMIN_SESSION_SECRET || env.ADMIN_SESSION_SECRET.length < 32) {
      missing.push('ADMIN_SESSION_SECRET (min 32 chars)');
    }
    if (missing.length) {
      throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
    }
  }

  return {
    ...env,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    sessionSecret: env.ADMIN_SESSION_SECRET ?? 'dev-only-insecure-session-secret-change-me',
    ipHashSalt: env.IP_HASH_SALT ?? 'dev-only-ip-salt',
    smtpFrom: env.SMTP_FROM ?? 'CHFR LDN <no-reply@chfrldn.com>',
  };
}

export const config: AppConfig = build();
export const buildConfig = build;
