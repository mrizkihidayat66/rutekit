import type { ProxyProtocol } from '@contracts';

/**
 * Reading one line of a bulk proxy paste (C7a, FR-5.x).
 *
 * A paste arrives in whatever shape the seller's list uses, so the scheme and the
 * credentials are both optional: `host:port` alone is the common case and means
 * plain HTTP, `socks5://host:port` is the next commonest, and
 * `http://user:pass@host:port` is what a paid residential pool hands out. All
 * three have to work, because the operator is pasting a list they did not write.
 *
 * **The last `@` and the last `:` are the separators.** A password may contain
 * either character — a generated one usually does — and splitting on the first
 * occurrence would truncate the host into the password and produce a proxy that
 * connects to nothing. Splitting from the right is what makes a password with a
 * colon in it survive.
 *
 * The failure is a sentence rather than a boolean, because it is shown back to
 * the operator against the line number that produced it. A paste of two hundred
 * lines usually has one malformed row, and "line 47: no port" is the difference
 * between fixing the list and re-reading all of it.
 *
 * Pure: a line in, a parsed proxy or a reason out.
 */

export interface ParsedProxy {
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
}

export type ProxyLineResult =
  | { readonly ok: true; readonly proxy: ParsedProxy }
  | { readonly ok: false; readonly error: string };

/**
 * Any scheme-looking prefix, not just the three that are supported.
 *
 * Matching only the supported ones would let `ftp://host:21` through the
 * supported-scheme branch untouched and then read `ftp://host` as the hostname —
 * a pool entry pointing at nothing, accepted without a word. Catching every
 * scheme is what makes "unknown scheme" a refusal.
 */
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//iu;

const PROTOCOLS: Readonly<Record<string, ProxyProtocol>> = {
  http: 'http',
  https: 'https',
  socks5: 'socks5',
};

export function parseProxyLine(raw: string): ProxyLineResult {
  const line = raw.trim();
  if (line === '') return { ok: false, error: 'empty line' };

  let rest = line;
  let protocol: ProxyProtocol = 'http';
  const scheme = SCHEME.exec(line);
  if (scheme !== null) {
    const name = (scheme[1] ?? '').toLowerCase();
    const mapped = PROTOCOLS[name];
    if (mapped === undefined) {
      return { ok: false, error: `unknown scheme "${name}" — use http, https or socks5` };
    }
    protocol = mapped;
    rest = line.slice(scheme[0].length);
  }

  let username: string | null = null;
  let password: string | null = null;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const credentials = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = credentials.indexOf(':');
    username = colon === -1 ? credentials : credentials.slice(0, colon);
    password = colon === -1 ? null : credentials.slice(colon + 1);
  }

  // A bracketed IPv6 literal carries its own colons, so the port separator has to
  // be looked for after the closing bracket rather than at the last colon.
  const portColon = rest.startsWith('[')
    ? rest.indexOf(']:') === -1
      ? -1
      : rest.indexOf(']:') + 1
    : rest.lastIndexOf(':');
  if (portColon === -1) return { ok: false, error: 'no port — expected host:port' };

  const host = stripBrackets(rest.slice(0, portColon));
  const port = Number.parseInt(rest.slice(portColon + 1), 10);
  if (host === '') return { ok: false, error: 'no host' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'port must be a whole number between 1 and 65535' };
  }

  return { ok: true, proxy: { protocol, host, port, username, password } };
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * The credential a parsed line carries, as the one string the box encrypts.
 *
 * JSON rather than `user:pass`, because a password may itself contain a colon
 * and the two halves must survive a round trip unambiguously. Null when the line
 * named no credentials at all, which is the common case for a free pool.
 */
export function credentialOf(proxy: ParsedProxy): string | null {
  if (proxy.username === null && proxy.password === null) return null;
  return JSON.stringify({ username: proxy.username, password: proxy.password });
}

/** The parts back out of a stored credential. Null when the envelope held neither. */
export function readCredential(raw: string): { username: string; password: string } | null {
  try {
    const parsed = JSON.parse(raw) as { username?: unknown; password?: unknown };
    const username = typeof parsed.username === 'string' ? parsed.username : '';
    const password = typeof parsed.password === 'string' ? parsed.password : '';
    if (username === '' && password === '') return null;
    return { username, password };
  } catch {
    return null;
  }
}

/**
 * The proxy URL a client connects through.
 *
 * Credentials are percent-encoded into the authority, because a password with an
 * `@` or a `/` in it would otherwise change where the URL points — which is the
 * same class of bug the right-to-left split above exists to avoid.
 */
export function proxyUrl(proxy: ParsedProxy): string {
  const authority =
    proxy.username === null && proxy.password === null
      ? proxy.host
      : `${encodeURIComponent(proxy.username ?? '')}:${encodeURIComponent(proxy.password ?? '')}@${proxy.host}`;
  return `${proxy.protocol}://${authority}:${String(proxy.port)}`;
}
