import type { Request, Response, NextFunction } from 'express';
import { db } from '../../db/index.js';
import { logger } from '../../utils/logger.js';
import { hashIp } from '../../utils/crypto.js';
import { RateLimitError } from '../../utils/errors.js';

/**
 * Durable rate limiting backed by Postgres.
 *
 * In-memory counters reset on every deploy and are per-instance; a table costs
 * one small query per request and survives restarts. The bucket key is a hashed
 * IP, so no address is ever stored.
 */

export interface RateLimitOptions {
  name: string;
  max: number;
  windowMinutes: number;
  /** Defaults to the hashed client IP. */
  key?: (req: Request) => string;
  message?: string;
}

export async function consume(bucket: string, max: number, windowMinutes: number): Promise<{ allowed: boolean; hits: number }> {
  const { rows } = await db().query<{ hits: number; expired: boolean }>(
    `INSERT INTO rate_limits (bucket, hits, window_start)
          VALUES ($1, 1, now())
     ON CONFLICT (bucket) DO UPDATE
            SET hits = CASE
                         WHEN rate_limits.window_start < now() - ($2 || ' minutes')::interval THEN 1
                         ELSE rate_limits.hits + 1
                       END,
                window_start = CASE
                         WHEN rate_limits.window_start < now() - ($2 || ' minutes')::interval THEN now()
                         ELSE rate_limits.window_start
                       END
       RETURNING hits, false AS expired`,
    [bucket, String(windowMinutes)],
  );

  const hits = Number(rows[0]?.hits ?? 1);
  return { allowed: hits <= max, hits };
}

export function rateLimit(options: RateLimitOptions) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const identity = options.key ? options.key(req) : (hashIp(clientIp(req)) ?? 'unknown');
      const bucket = `${options.name}:${identity}`;
      const { allowed, hits } = await consume(bucket, options.max, options.windowMinutes);

      if (!allowed) {
        logger.warn({ bucket: options.name, hits }, 'Rate limit exceeded');
        return next(new RateLimitError(options.message));
      }
    } catch (err) {
      // Fail open: a rate-limiter outage must not stop customers booking.
      logger.error({ err }, 'Rate limit check failed — allowing request');
    }
    next();
  };
}

export function clientIp(req: Request): string | undefined {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim();
  return req.ip ?? req.socket?.remoteAddress ?? undefined;
}

/** Housekeeping so the table cannot grow without bound. */
export async function purgeOldRateLimits(): Promise<void> {
  try {
    await db().query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  } catch (err) {
    logger.error({ err }, 'Failed to purge rate limit buckets');
  }
}
