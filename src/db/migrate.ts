import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, db, closeDatabase, type Queryable } from './index.js';
import { logger } from '../utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

// Migrations ship as .sql next to the compiled output; when running from
// dist/ the source directory is the fallback so `npm run migrate:prod` works
// whether or not the build step copied them.
async function migrationsDir(): Promise<string> {
  const candidates = [join(here, 'migrations'), join(process.cwd(), 'src', 'db', 'migrations')];
  for (const dir of candidates) {
    try {
      const files = await readdir(dir);
      if (files.some((f) => f.endsWith('.sql'))) return dir;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`No migrations directory found. Looked in: ${candidates.join(', ')}`);
}

async function ensureLedger(q: Queryable): Promise<void> {
  await q.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(): Promise<string[]> {
  const database = db();
  await ensureLedger(database);

  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await database.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    // Each migration runs in its own transaction: a failure rolls back cleanly
    // and leaves the ledger untouched so it can be retried.
    await database.transaction(async (tx) => {
      // Migration files hold many statements, so they go through exec().
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
    logger.info({ migration: file }, 'Applied migration');
  }

  if (ran.length === 0) logger.info('Database schema already up to date');
  return ran;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/');

if (invokedDirectly) {
  initDatabase()
    .then(() => runMigrations())
    .then(async (ran) => {
      // eslint-disable-next-line no-console
      console.log(ran.length ? `Applied ${ran.length} migration(s): ${ran.join(', ')}` : 'Schema up to date.');
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'Migration failed');
      // eslint-disable-next-line no-console
      console.error('Migration failed:', err instanceof Error ? err.message : err);
      await closeDatabase().catch(() => undefined);
      process.exit(1);
    });
}
