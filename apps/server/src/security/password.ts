import { createHmac } from 'node:crypto';

/**
 * The single-user password (D8, ADR-0008).
 *
 * Argon2id, through Bun's own implementation: no native module to compile, and
 * the cost parameters travel inside the stored PHC string, so they can be raised
 * later without a migration.
 *
 * `RUTEKIT_AUTH_SECRET`, when set, is applied as a *pepper* — the password is
 * HMAC-SHA256'd with it before hashing, so the stored value cannot be attacked
 * offline with the database alone: the attacker also needs the secret, which
 * lives in the environment and never in the database. Set it before the first
 * run; changing it afterwards makes the existing password unverifiable, which is
 * the correct outcome for a secret that is supposed to be fixed.
 */

/** OWASP's argon2id baseline: 19 MiB, two passes, one lane. */
const ARGON2_OPTIONS = { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2 } as const;

/** Apply the pepper. With no secret configured the password is hashed as-is. */
function pepper(password: string, authSecret: string | null): string {
  if (authSecret === null || authSecret === '') return password;
  return createHmac('sha256', authSecret).update(password, 'utf8').digest('base64');
}

export async function hashPassword(password: string, authSecret: string | null): Promise<string> {
  return Bun.password.hash(pepper(password, authSecret), ARGON2_OPTIONS);
}

/**
 * Verify against a stored hash. A malformed hash is a failed login, not a crash:
 * the stored value is ours, but a corrupted row should lock the door, not break
 * the route that opens it.
 */
export async function verifyPassword(
  password: string,
  hash: string,
  authSecret: string | null,
): Promise<boolean> {
  try {
    return await Bun.password.verify(pepper(password, authSecret), hash);
  } catch {
    return false;
  }
}
