import bcrypt from 'bcryptjs';

/**
 * bcrypt with a work factor of 12. Pure-JS implementation so there is no native
 * build step on Render, at the cost of some speed — acceptable for a login form.
 */
const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** A dummy hash to compare against when the email does not exist, so that a
 *  wrong email and a wrong password take the same amount of time. */
export const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO1J1sZ8YRJfW9pQ5A0O9F6qEo6qKZ8gq';

export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 12) issues.push('Password must be at least 12 characters.');
  if (!/[a-z]/.test(password)) issues.push('Password must contain a lowercase letter.');
  if (!/[A-Z]/.test(password)) issues.push('Password must contain an uppercase letter.');
  if (!/[0-9]/.test(password)) issues.push('Password must contain a number.');
  return issues;
}
