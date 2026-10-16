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
  /**
   * Every string field the stored credential carries, by name.
   *
   * **The known fields above are not enough, and kiro is why.** A sign-in that
   * returns more than a token returns fields a codec may need in the request
   * body: kiro issues a `profileArn` beside its token and its runtime refuses a
   * call without one. Picking named fields out of the blob — which is what this
   * used to do — drops the rest silently, and the codec then has nowhere to read
   * them from. Handing the whole set over costs nothing and means the next
   * provider with an extra field needs no change here.
   *
   * Empty for a credential that is not a JSON object: a pasted key has no named
   * fields to offer.
   */
  readonly fields: Readonly<Record<string, string>>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The string fields of a parsed credential, or none when it is not an object. */
function stringFieldsOf(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const fields: Record<string, string> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (typeof field === 'string' && field !== '') fields[key] = field;
  }
  return fields;
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

  const parsed = parseJson(plaintext);
  const fields = stringFieldsOf(parsed);

  const oauth = asOauth(parsed);
  if (oauth !== null) return { value: oauth.accessToken, expiresAt: oauth.expiresAt, fields };
  return plaintext === '' ? null : { value: plaintext, expiresAt: null, fields };
}
