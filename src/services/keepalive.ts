import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Keeps a Render free instance awake by requesting its own public URL.
 *
 * Render spins a free web service down after about 15 minutes with no inbound
 * traffic, and the next customer then waits around 50 seconds for the site to
 * start. A request to localhost never reaches Render's router, so the ping has
 * to go out to the onrender.com hostname and come back in.
 *
 * It fetches a small static file, not /api/health: the health check queries
 * the database, and pinging it every ten minutes would keep Neon's free
 * compute awake around the clock as well.
 *
 * OFF unless KEEPALIVE=true. An awake instance spends about 24 free instance
 * hours a day, and the 750 a month are shared by every free service in the
 * Render workspace. Two services kept awake in one workspace run out mid-month
 * and Render suspends all of them, which took the site down in October 2026.
 */
const PING_INTERVAL_MS = 10 * 60 * 1000;
const PING_PATH = '/assets/favicon.svg';

export function startKeepAlive(): NodeJS.Timeout | undefined {
  if (!config.isProduction || !config.KEEPALIVE) return undefined;

  // RENDER_EXTERNAL_URL, not APP_URL: a standby copy has APP_URL set to the
  // live domain, and pinging that would keep the other service awake instead.
  const base = config.RENDER_EXTERNAL_URL?.replace(/\/+$/, '');
  if (!base) {
    logger.warn('KEEPALIVE is on but RENDER_EXTERNAL_URL is not set, so nothing is pinged');
    return undefined;
  }

  const target = `${base}${PING_PATH}`;
  const tick = async () => {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) logger.warn({ target, status: res.status }, 'Keep-alive ping was refused');
    } catch (err) {
      logger.warn({ err, target }, 'Keep-alive ping failed');
    }
  };

  logger.info({ target, everyMinutes: PING_INTERVAL_MS / 60_000 }, 'Keep-alive is on');
  // One ping straight away, so a wrong URL shows up in the deploy logs.
  void tick();
  const timer = setInterval(tick, PING_INTERVAL_MS);
  timer.unref();
  return timer;
}
