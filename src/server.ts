import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { initDatabase, closeDatabase, db } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { loadRefOptions } from './domain/refOptions.js';
import { purgeExpiredSessions } from './auth/session.js';
import { purgeOldRateLimits } from './http/middleware/rateLimit.js';
import { createApp } from './http/app.js';

/**
 * Application entry point. Migrations run at boot so a Render deploy is a
 * single step, and the process refuses to start if the database is unreachable.
 */
async function main(): Promise<void> {
  await initDatabase();
  await runMigrations();
  await loadRefOptions(true);

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, appUrl: config.APP_URL },
      'CHFR LDN is listening',
    );
  });

  // Light housekeeping: expired sessions and stale rate-limit buckets.
  const housekeeping = setInterval(
    () => {
      purgeExpiredSessions().catch((err) => logger.error({ err }, 'Session purge failed'));
      purgeOldRateLimits().catch(() => undefined);
    },
    60 * 60 * 1000,
  );
  housekeeping.unref();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    clearInterval(housekeeping);
    server.close(async () => {
      await closeDatabase().catch(() => undefined);
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });

  void db;
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  // eslint-disable-next-line no-console
  console.error('Failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
