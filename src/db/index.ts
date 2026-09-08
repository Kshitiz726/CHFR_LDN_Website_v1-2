import pg from 'pg';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Thin database abstraction over node-postgres (production) and PGlite
 * (an embedded WASM build of Postgres, used by the test-suite so the tests run
 * real Postgres SQL without needing a server). Both speak the same dialect, so
 * application code never branches on the driver.
 */

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Runs a script that may contain several statements (used by migrations). */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'pg' | 'pglite';
}

// Return DATE / TIMESTAMPTZ-free types as plain strings rather than JS Dates so
// a journey date never shifts across a timezone boundary on its way out of the DB.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1083, (v) => v); // time
pg.types.setTypeParser(1114, (v) => v); // timestamp without time zone

class PgDatabase implements Database {
  readonly driver = 'pg' as const;
  constructor(private readonly pool: pg.Pool) {}

  async query<T = any>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: Queryable = {
        query: async (sql, params = []) => {
          const r = await client.query(sql, params as unknown[]);
          return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        },
        exec: async (script) => {
          await client.query(script);
        },
      };
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken — nothing useful to do */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PGliteDatabase implements Database {
  readonly driver = 'pglite' as const;
  constructor(private readonly db: any) {}

  async query<T = any>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.db.query(sql, params as unknown[]);
    return { rows: (res.rows ?? []) as T[], rowCount: res.affectedRows ?? res.rows?.length ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx: any) => {
      const wrapped: Queryable = {
        query: async (sql, params = []) => {
          const r = await tx.query(sql, params as unknown[]);
          return { rows: r.rows ?? [], rowCount: r.affectedRows ?? r.rows?.length ?? 0 };
        },
        exec: async (script) => {
          await tx.exec(script);
        },
      };
      return fn(wrapped);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

let instance: Database | undefined;

export async function initDatabase(): Promise<Database> {
  if (instance) return instance;

  if (config.DB_DRIVER === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    // Anything after `memory://` is an isolated in-process Postgres instance.
    const client = await PGlite.create('memory://chfr');
    instance = new PGliteDatabase(client);
    logger.info('Database initialised (pglite, in-memory)');
    return instance;
  }

  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Set it, or use DB_DRIVER=pglite for a throwaway in-memory database.');
  }

  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => logger.error({ err }, 'Idle postgres client error'));
  instance = new PgDatabase(pool);
  logger.info('Database initialised (postgres)');
  return instance;
}

export function db(): Database {
  if (!instance) throw new Error('Database has not been initialised — call initDatabase() first.');
  return instance;
}

export async function closeDatabase(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = undefined;
  }
}

/** Test-suite helper: swap in a pre-built database (or clear it). */
export function __setDatabaseForTests(next: Database | undefined): void {
  instance = next;
}
