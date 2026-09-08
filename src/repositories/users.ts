import { db, type Queryable } from '../db/index.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'STAFF';
  active: boolean;
  last_login_at: string | null;
  created_at: string;
}

interface UserWithHash extends UserRow {
  password_hash: string;
}

const COLUMNS = `id::text AS id, email, name, role, active, last_login_at, created_at`;

export async function findUserByEmail(email: string, q: Queryable = db()): Promise<UserWithHash | null> {
  const { rows } = await q.query<UserWithHash>(
    `SELECT ${COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string, q: Queryable = db()): Promise<UserRow | null> {
  if (!/^\d+$/.test(String(id))) return null;
  const { rows } = await q.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listUsers(q: Queryable = db()): Promise<UserRow[]> {
  const { rows } = await q.query<UserRow>(`SELECT ${COLUMNS} FROM users ORDER BY name`);
  return rows;
}

export async function createUser(
  data: { email: string; name: string; password_hash: string; role: 'ADMIN' | 'STAFF' },
  q: Queryable = db(),
): Promise<UserRow> {
  const { rows } = await q.query<UserRow>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING ${COLUMNS}`,
    [data.email.toLowerCase(), data.name, data.password_hash, data.role],
  );
  return rows[0]!;
}

export async function updateUserPassword(id: string, passwordHash: string, q: Queryable = db()): Promise<void> {
  await q.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [id, passwordHash]);
}

export async function setUserActive(id: string, active: boolean, q: Queryable = db()): Promise<void> {
  await q.query('UPDATE users SET active = $2, updated_at = now() WHERE id = $1', [id, active]);
}

export async function touchLogin(id: string, q: Queryable = db()): Promise<void> {
  await q.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

export async function countUsers(q: Queryable = db()): Promise<number> {
  const { rows } = await q.query<{ c: string }>('SELECT count(*)::text AS c FROM users');
  return Number(rows[0]?.c ?? 0);
}
