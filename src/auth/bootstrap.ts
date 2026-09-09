import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import * as usersRepo from '../repositories/users.js';
import { hashPassword, passwordIssues } from './password.js';

export interface BootstrapOutcome {
  status: 'created' | 'updated' | 'skipped' | 'rejected';
  email?: string;
  reason?: string;
}

/**
 * Creates or resets a staff account from environment variables.
 *
 * Hosting plans without shell access (Render's free tier among them) leave no
 * other way to make the first account, or to recover from a forgotten
 * password. Setting the variables and redeploying is the escape hatch.
 *
 * It is deliberately idempotent: running it again with the same email resets
 * that account's password rather than creating a second one.
 */
export async function bootstrapAdminFromEnv(): Promise<BootstrapOutcome> {
  const email = config.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = config.ADMIN_BOOTSTRAP_PASSWORD;

  if (!email || !password) return { status: 'skipped' };

  const issues = passwordIssues(password);
  if (issues.length) {
    // Never echo the password, only what is wrong with it.
    logger.error(
      { email, issues },
      'ADMIN_BOOTSTRAP_PASSWORD does not meet the password policy — no account was created',
    );
    return { status: 'rejected', email, reason: issues.join(' ') };
  }

  const role = config.ADMIN_BOOTSTRAP_ROLE === 'STAFF' ? 'STAFF' : 'ADMIN';
  const name = config.ADMIN_BOOTSTRAP_NAME?.trim() || email.split('@')[0] || 'CHFR Staff';
  const passwordHash = await hashPassword(password);

  const existing = await usersRepo.findUserByEmail(email);

  if (existing) {
    await usersRepo.updateUserPassword(existing.id, passwordHash);
    await usersRepo.setUserActive(existing.id, true);
    logger.warn(
      { email, role: existing.role },
      'Password reset from ADMIN_BOOTSTRAP_* environment variables. ' +
        'Remove ADMIN_BOOTSTRAP_PASSWORD from the environment now that it has been applied.',
    );
    return { status: 'updated', email };
  }

  await usersRepo.createUser({ email, name, password_hash: passwordHash, role });
  logger.warn(
    { email, role },
    'Staff account created from ADMIN_BOOTSTRAP_* environment variables. ' +
      'Remove ADMIN_BOOTSTRAP_PASSWORD from the environment now that it has been applied.',
  );
  return { status: 'created', email };
}
