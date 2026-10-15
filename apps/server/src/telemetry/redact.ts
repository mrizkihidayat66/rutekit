/**
 * Scrubbing secrets out of a captured payload (SEC-6).
 *
 * A payload capture is the one place rutekit stores a request body, and a request
 * body is exactly where a credential ends up: a client that points its SDK at
 * rutekit sends `Authorization` in a header (which is never captured), but a
 * body can carry an API key as a field, a password as a parameter, or a token
 * inside a tool definition's schema. The logger already censors its own fields;
 * this is the same discipline applied to bytes rutekit is about to write to disk
 * and then show in a panel.
 *
 * Two passes, because there are two ways a secret hides:
 *
 *   1. **By name.** A key called `api_key`, `password`, `token` and so on is
 *      replaced wherever it appears, at any depth. This is the pass that catches
 *      the ordinary case, and it is why the field list is shared with the
 *      logger's rather than invented again here.
 *   2. **By shape.** A *value* that looks like a credential — a long
 *      `sk-`-prefixed string, a JWT, a bearer token, a long random run — is
 *      replaced even when its key is innocuous. Without this, `{"note": "sk-…"}`
 *      is a leak, and "somebody pasted the key into the wrong field" is not a
 *      hypothetical.
 *
 * The function reports whether it changed anything, because the console's panel
 * says "redacted" and a panel that claims that when nothing was redacted is as
 * misleading as one that stays silent when something was.
 *
 * Pure: a value in, a value and a flag out. It never mutates its input.
 */

/** Field names whose value is a secret wherever they appear. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'apikey',
  'api_key',
  'keyhint',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'secret',
  'clientsecret',
  'client_secret',
  'authorization',
  'cookie',
  'setcookie',
  'set-cookie',
  'encryptionkey',
  'encryption_key',
  'authsecret',
  'auth_secret',
  'capsolverkey',
  'capsolver_key',
  'credential',
  'sessiontoken',
  'session_token',
]);

export const REDACTED = '[redacted]';

/**
 * Values that are credentials regardless of the key they sit under.
 *
 * Each pattern is anchored and length-bounded so ordinary text is not swallowed:
 * a vendor prefix with a real key's length behind it, a three-part JWT, a bearer
 * scheme, and a long opaque run that contains a digit — which is what a pasted
 * session cookie or hex secret looks like, and what an English word never does.
 *
 * That digit requirement is the one that keeps this usable. Without it the last
 * pattern matches any twenty-eight-character word or path segment, and an
 * inspector that redacts the request it was opened to show is worse than one that
 * shows nothing at all.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // `sk-`, `sk-proj-`, `gsk_`, `xai-` and the rest, followed by enough characters
  // that it cannot be an English word.
  /\b(?:sk|rk|pk|gsk|xai|api)[-_][A-Za-z0-9_-]{16,}\b/u,
  // A bearer token, wherever it appears as text rather than as a header.
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/u,
  // A JWT: three base64url segments, the first of which is always `eyJ` because
  // every JWT header starts with `{"`.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  // A long opaque run: at least twenty-eight characters, and at least one digit.
  /\b(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{28,}={0,2}\b/u,
];

export interface RedactionOutcome {
  readonly value: unknown;
  /** True when at least one value was replaced. */
  readonly redacted: boolean;
}

export function redactPayload(value: unknown): RedactionOutcome {
  let redacted = false;

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const next = redactString(node);
      if (next !== node) redacted = true;
      return next;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;

    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(node)) {
      if (SECRET_KEYS.has(key.toLowerCase())) {
        out[key] = REDACTED;
        redacted = true;
        continue;
      }
      out[key] = walk(inner);
    }
    return out;
  };

  return { value: walk(value), redacted };
}

/** A string with any credential-shaped run in it replaced. */
function redactString(value: string): string {
  let next = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // A global clone, because a shared regex with the `g` flag carries
    // `lastIndex` between calls and would skip matches on alternate uses.
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    next = next.replace(global, REDACTED);
  }
  return next;
}
