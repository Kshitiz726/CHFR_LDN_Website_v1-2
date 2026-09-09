import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { initDatabase, closeDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import * as usersRepo from '../repositories/users.js';
import { hashPassword, passwordIssues } from '../auth/password.js';

/**
 * Creates (or updates) a staff account.
 *
 * Values can come from ADMIN_BOOTSTRAP_EMAIL / _NAME / _PASSWORD / _ROLE for a
 * non-interactive first deploy, or be typed in when run at a terminal.
 */

/* eslint-disable no-console */
async function main(): Promise<void> {
  await initDatabase();
  await runMigrations();

  const fromEnv = {
    email: process.env.ADMIN_BOOTSTRAP_EMAIL,
    name: process.env.ADMIN_BOOTSTRAP_NAME,
    password: process.env.ADMIN_BOOTSTRAP_PASSWORD,
    role: (process.env.ADMIN_BOOTSTRAP_ROLE as 'ADMIN' | 'STAFF' | undefined) ?? 'ADMIN',
  };

  let email = fromEnv.email;
  let name = fromEnv.name;
  let password = fromEnv.password;
  const role: 'ADMIN' | 'STAFF' = fromEnv.role === 'STAFF' ? 'STAFF' : 'ADMIN';

  if (!email || !password) {
    if (!stdin.isTTY) {
      throw new Error(
        'Set ADMIN_BOOTSTRAP_EMAIL, ADMIN_BOOTSTRAP_NAME and ADMIN_BOOTSTRAP_PASSWORD, or run this command interactively.',
      );
    }
    const rl = createInterface({ input: stdin, output: stdout });
    email = email ?? (await rl.question('Email: '));
    name = name ?? (await rl.question('Full name: '));
    password = password ?? (await rl.question('Password (min 12 chars, upper + lower + number): '));
    rl.close();
  }

  email = String(email).trim().toLowerCase();
  name = String(name ?? email.split('@')[0]).trim();
  password = String(password);

  const issues = passwordIssues(password);
  if (issues.length) throw new Error(issues.join(' '));

  const existing = await usersRepo.findUserByEmail(email);
  const passwordHash = await hashPassword(password);

  if (existing) {
    await usersRepo.updateUserPassword(existing.id, passwordHash);
    await usersRepo.setUserActive(existing.id, true);
    console.log(`Updated the password for existing account ${email} (role ${existing.role}).`);
  } else {
    const user = await usersRepo.createUser({ email, name, password_hash: passwordHash, role });
    console.log(`Created ${user.role} account for ${user.email}.`);
  }
  console.log('');
  console.log('No shell on your hosting plan? Set ADMIN_BOOTSTRAP_EMAIL and');
  console.log('ADMIN_BOOTSTRAP_PASSWORD as environment variables instead — the account is');
  console.log('created on the next deploy. Remove the password variable afterwards.');

  console.log('Sign in at /admin/login');
  await closeDatabase();
}

main().catch(async (err) => {
  console.error('Could not create the account:', err instanceof Error ? err.message : err);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
