import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE and the state parameter (C3b2).
 *
 * Two random values guard the redirect, and they guard different things. `state`
 * is the one that makes the round trip: it goes to the provider and has to come
 * back unchanged, which is what stops a code minted in one browser session from
 * being replayed into another. The verifier never leaves rutekit — only its
 * SHA-256 travels, and the exchange presents the original — which is what makes
 * an intercepted code useless on its own.
 *
 * Both are 32 random bytes, which base64url renders as 43 characters: the
 * shortest length PKCE allows, and far past anything worth guessing.
 */

/** 32 bytes → 43 base64url characters, with no padding to strip. */
const RANDOM_BYTES = 32;

/** The verifier: minted when the flow starts, presented only at the exchange. */
export function createCodeVerifier(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url');
}

/**
 * `S256`, the only method worth using. The RFC also allows `plain` for clients
 * that cannot hash; rutekit can, and a challenge equal to its verifier is no
 * challenge at all.
 */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** The value the callback has to return untouched, or the flow is abandoned. */
export function createState(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url');
}
