import {
  cidrContains,
  isBlockedAddress,
  parseAddress,
  parseCidr,
  stripBrackets,
  type Cidr,
} from './ip-address';

/**
 * Egress policy for outbound provider calls (C2: "SSRF: validasi egress saat
 * pembuatan & koneksi; allowlist jaringan; tanpa fallback diam-diam").
 *
 * Two moments are checked, because they catch different attacks. At *creation*
 * the target is a string the operator typed: the scheme must be http(s), no
 * credentials may be embedded in it, and a literal address in the host must not
 * be private. A hostname is deliberately *not* resolved there — resolving at
 * creation and again at connect would race, and the answer that matters is the
 * one at connect. At *connect* the address the socket is actually about to reach
 * is checked against the same table; that is the check a DNS rebind cannot slip
 * past, because it runs after resolution and before the connection.
 *
 * The allowlist is the operator's escape hatch: a provider deliberately hosted on
 * a private network is reachable by naming that network here, and nothing else
 * is. A malformed entry throws at construction rather than being dropped — a
 * typo in a security allowlist must be loud, not silently ignored.
 */

export type EgressDenial =
  | 'invalid-url'
  | 'unsupported-scheme'
  | 'embedded-credentials'
  | 'blocked-address'
  | 'invalid-address';

export type EgressDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: EgressDenial };

const ALLOWED: EgressDecision = { allowed: true };
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

function deny(reason: EgressDenial): EgressDecision {
  return { allowed: false, reason };
}

export class EgressPolicy {
  readonly #allowlist: readonly Cidr[];

  constructor(allowlist: readonly string[] = []) {
    this.#allowlist = allowlist.map((entry) => {
      const cidr = parseCidr(entry);
      if (cidr === null) throw new Error(`invalid egress allowlist entry: ${entry}`);
      return cidr;
    });
  }

  /** Creation-time check of a URL the operator supplied. A hostname passes here. */
  checkUrl(raw: string): EgressDecision {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return deny('invalid-url');
    }
    if (!ALLOWED_SCHEMES.has(url.protocol)) return deny('unsupported-scheme');
    if (url.username !== '' || url.password !== '') return deny('embedded-credentials');
    const host = stripBrackets(url.hostname);
    if (parseAddress(host) === null) return ALLOWED;
    return this.checkAddress(host);
  }

  /** Connect-time check of the address a socket is about to reach. Fails closed. */
  checkAddress(address: string): EgressDecision {
    if (parseAddress(address) === null) return deny('invalid-address');
    if (this.#allowlisted(address)) return ALLOWED;
    if (isBlockedAddress(address)) return deny('blocked-address');
    return ALLOWED;
  }

  #allowlisted(address: string): boolean {
    return this.#allowlist.some((cidr) => cidrContains(cidr, address));
  }
}
