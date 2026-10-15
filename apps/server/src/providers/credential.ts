import type { ProviderAccountRow } from '@server/persistence/provider-accounts.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import type { StoredCredential } from './oauth/store.ts';

/**
 * Reading an account's credential back, for the one purpose that needs it (C4.6).
 *
 * `oauth/store.ts` is the write half and never reads; this is the read half and
 * never writes. The plaintext exists here for exactly as long as it takes to put
 * it in an upstream `Authorization` header, and nothing in this module returns a
 * value a route could render — the row's mask stays the only thing about an
 * account that can be shown.
 *
 * Two shapes share the one envelope column. An OAuth sign-in stores
 * `StoredCredential` as JSON; an account added by hand stores the operator's own
 * key, which is not JSON at all. Rather than tag the row with which it holds, the
 * parse is attempted and its failure is the answer: a JSON object carrying an
 * `accessToken` is a token, and anything else is a key as written. One column
 * stays one column, and C5 can add a third shape without a migration.
 */

export interface AccountCredential {
  /** The value to send upstream: an access token, or a key as the operator wrote it. */
  readonly value: string;
  /** When the provider said the token stops being valid; null when it did not. */
  readonly expiresAt: string | null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The stored envelope as an OAuth token, or null when it is something else. */
function asOauth(value: unknown): StoredCredential | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const accessToken = record['accessToken'];
  if (typeof accessToken !== 'string' || accessToken === '') return null;
  const expiresAt = record['expiresAt'];
  const optional = (key: string): string | null => {
    const field = record[key];
    return typeof field === 'string' && field !== '' ? field : null;
  };
  return {
    accessToken,
    refreshToken: optional('refreshToken'),
    tokenType: optional('tokenType'),
    scope: optional('scope'),
    expiresAt: typeof expiresAt === 'string' && expiresAt !== '' ? expiresAt : null,
  };
}

/**
 * The credential an account holds, or null when there is nothing usable.
 *
 * Null covers three different situations that a caller treats identically — no
 * encryption key configured, an envelope that will not decrypt, and an empty
 * plaintext — because all three mean "this account cannot be used", and guessing
 * at which one is the caller's job only when it has something different to say
 * about each.
 */
export function readCredential(
  secrets: SecretBox | null,
  row: ProviderAccountRow,
): AccountCredential | null {
  if (secrets === null) return null;

  let plaintext: string;
  try {
    plaintext = secrets.decrypt(row.credentialEnvelope);
  } catch {
    // A tampered, truncated or foreign envelope is not a credential. Sending it
    // upstream would report the provider's confusion instead of our own.
    return null;
  }

  const oauth = asOauth(parseJson(plaintext));
  if (oauth !== null) return { value: oauth.accessToken, expiresAt: oauth.expiresAt };
  return plaintext === '' ? null : { value: plaintext, expiresAt: null };
}
