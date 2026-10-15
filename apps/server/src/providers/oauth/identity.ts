/**
 * Whose account this is (C3b2).
 *
 * A completed exchange proves the provider let rutekit in; it does not say which
 * account answered. The name is in the `id_token`, and reading it means decoding
 * the middle segment of a JWT without checking the signature — which is
 * deliberate and narrow. The signature exists to guard a token that reached the
 * reader through a third party; this one did not. It arrived in the same TLS
 * response as the access token, from the endpoint rutekit called, in answer to
 * rutekit's own client credential. Nothing else in the token is read, and nothing
 * in it is trusted beyond the one claim.
 *
 * What gets kept is the mask, never the address. The account list is a read model
 * an operator reads, and the fixture's rows carry `a***b@example.com` for exactly
 * that reason: an address written to disk once outlives every later decision to
 * hide it. Masking before the insert is the only version of that rule that holds.
 */

const JWT_SEGMENTS = 3;
const MASKED_LOCAL = '***';

/** The verified address a provider volunteered, or null when it volunteered none. */
export function emailFromIdToken(idToken: string | null): string | null {
  if (idToken === null) return null;
  const segments = idToken.split('.');
  if (segments.length !== JWT_SEGMENTS) return null;

  const payload = decodeSegment(segments[1] ?? '');
  if (payload === null) return null;

  const email = payload['email'];
  // An `@` is the whole test: an operator's label for a malformed claim is worth
  // less than the honest null, and this value is a lookup key, not a display name.
  return typeof email === 'string' && email.includes('@') ? email : null;
}

/**
 * Keep the first and last character of the local part and the domain, drop the
 * rest. Enough for an operator to tell two accounts apart, not enough to be one.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return MASKED_LOCAL;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain === '') return MASKED_LOCAL;
  const tail = local.length > 1 ? local.slice(-1) : '';
  return `${local.slice(0, 1)}${MASKED_LOCAL}${tail}@${domain}`;
}

/** The JWT payload, or null when the segment is not the base64url of a JSON object. */
function decodeSegment(segment: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
