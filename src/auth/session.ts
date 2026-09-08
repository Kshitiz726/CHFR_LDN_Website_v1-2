import { db, type Queryable } from '../db/index.js';
import { config } from '../config/env.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import type { UserRow } from '../repositories/users.js';

/**
 * Server-side sessions stored in Postgres.
 *
 * The cookie carries a random token; only its SHA-256 is stored, so a database
 * dump does not hand an attacker usable sessions. Logout and revocation are a
 * DELETE, and sessions survive a deploy.
 */

export const SESSION_COOKIE = 'chfr_session';

export interface SessionRecord {
  tokenHash: string;
  csrfToken: string;
  user: UserRow;
  expiresAt: string;
}

export async function createSession(
  user: UserRow,
  meta: { userAgent?: string | null; ipHash?: string | null } = {},
  q: Queryable = db(),
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);

  await q.query(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, user_agent, ip_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      sha256(token),
      user.id,
      csrfToken,
      meta.userAgent ? meta.userAgent.slice(0, 400) : null,
      meta.ipHash ?? null,
      expiresAt.toISOString(),
    ],
  );

  return { token, csrfToken, expiresAt };
}

export async function findSession(token: string, q: Queryable = db()): Promise<SessionRecord | null> {
  if (!token) return null;

  const { rows } = await q.query<{
    token_hash: string;
    csrf_token: string;
    expires_at: string;
    id: string;
    email: string;
    name: string;
    role: 'ADMIN' | 'STAFF';
    active: boolean;
    last_login_at: string | null;
    created_at: string;
  }>(
    `SELECT s.token_hash, s.csrf_token, s.expires_at,
            u.id::text AS id, u.email, u.name, u.role, u.active, u.last_login_at, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );

  const row = rows[0];
  // A deactivated account's existing sessions stop working immediately.
  if (!row || !row.active) return null;

  return {
    tokenHash: row.token_hash,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      active: row.active,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
    },
  };
}

export async function destroySession(token: string, q: Queryable = db()): Promise<void> {
  if (!token) return;
  await q.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function destroyUserSessions(userId: string, q: Queryable = db()): Promise<void> {
  await q.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function purgeExpiredSessions(q: Queryable = db()): Promise<number> {
  const { rowCount } = await q.query('DELETE FROM sessions WHERE expires_at <= now()');
  return rowCount;
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    // Lax still sends the cookie on top-level navigations, so the "Open booking"
    // link in the internal email lands the user logged in.
    sameSite: 'lax' as const,
    secure: config.isProduction,
    path: '/',
    expires: expiresAt,
  };
}
