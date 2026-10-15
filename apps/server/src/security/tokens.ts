import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque secrets and the form they are stored in.
 *
 * An API key or a session token is minted here, shown once, and never written
 * down — what the database keeps is the SHA-256 of it (R5.10). Lookup is by that
 * hash, so a stolen database yields nothing usable: the only way to present a key
 * is to hold the original, and 256 random bits are not something to guess.
 *
 * SHA-256 rather than Argon2 is deliberate, and is *not* the same choice as the
 * password. A password is short, human-chosen, and worth slowing a guesser down
 * for; a minted token is 256 random bits, where a slow hash would buy nothing and
 * cost a hash on every authenticated request.
 */

/** Head of every console-issued API key, so one is recognisable in a log. */
const API_KEY_PREFIX = 'rk-';
/** 32 bytes → 43 base64url characters. */
const TOKEN_BYTES = 32;
/** How much of a key is safe to show later; the contract's own example is `rk-a1b2`. */
const PREFIX_LENGTH = 7;

export interface MintedApiKey {
  /** The value shown to the operator exactly once. */
  readonly secret: string;
  /** Display-only head of `secret`; never enough to reconstruct it. */
  readonly prefix: string;
  /** What is stored. */
  readonly hash: string;
}

export interface MintedSessionToken {
  /** The cookie value. */
  readonly token: string;
  /** What is stored. */
  readonly hash: string;
}

/** The stored form of any opaque secret. One function, so nothing hashes ad hoc. */
export function hashToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function mintApiKey(): MintedApiKey {
  const secret = `${API_KEY_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, PREFIX_LENGTH), hash: hashToken(secret) };
}

export function mintSessionToken(): MintedSessionToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token) };
}
