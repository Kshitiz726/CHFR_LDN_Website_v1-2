import { z } from 'zod';

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

  // Security
  ADMIN_SESSION_SECRET: optStr,
  SESSION_TTL_HOURS: int(12),
  IP_HASH_SALT: optStr,

  // Email
  ADMIN_EMAIL: z.string().default('CHFRLONDON@GMAIL.COM'),
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
