import pino from 'pino';
import { config } from '../config/env.js';

/**
 * Structured logging. `redact` is the last line of defence — services are
 * expected not to pass secrets in the first place, but if one slips through a
 * log call it is replaced rather than written to disk.
 */
export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  base: { service: 'chfr-ldn' },
  redact: {
    paths: [
      'password',
      'passwordHash',
      'password_hash',
      '*.password',
      '*.passwordHash',
      'apiKey',
      'api_key',
      '*.apiKey',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.cookie',
      'headers["x-api-key"]',
      'SMTP_PASSWORD',
      'OPENWA_API_KEY',
      'GOOGLE_SERVICE_ACCOUNT_JSON',
      'token',
      'sessionToken',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
