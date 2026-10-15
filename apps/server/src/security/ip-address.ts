/**
 * Address classification for the egress guard.
 *
 * The check the SSRF guard has to make is on the *address*, never on the
 * hostname: a name that resolves to `127.0.0.1` is refused even when it reads
 * like a public host, and that is exactly the class of attack a hostname
 * denylist misses. Everything here is pure arithmetic over a parsed address, so
 * it can be tested without a socket.
 *
 * An address is parsed to a `bigint` and matched against a table of blocked
 * prefixes. `parseAddress` returns `null` for anything that is not an address —
 * a bare hostname — and callers decide what that means: the URL policy defers a
 * name to connect time, the connect-time policy fails closed.
 */

const V4_BITS = 32;
const V6_BITS = 128;
const V4_MASK = 0xffff_ffffn;

export interface ParsedAddress {
  readonly value: bigint;
  /** 32 for IPv4, 128 for IPv6. */
  readonly bits: number;
}

export interface Cidr extends ParsedAddress {
  /** Prefix length; `bits` is the family width. */
  readonly prefix: number;
}

export function parseIPv4(address: string): bigint | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

export function parseIPv6(address: string): bigint | null {
  // A zone id (`fe80::1%eth0`) names an interface, not a different address.
  const zone = address.indexOf('%');
  const text = zone === -1 ? address : address.slice(0, zone);
  if (!text.includes(':')) return null;

  // `::ffff:1.2.3.4` — fold the embedded dotted quad into two hex groups first.
  let normalised = text;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const embedded = parseIPv4(tail);
    if (embedded === null) return null;
    const hi = ((embedded >> 16n) & 0xffffn).toString(16);
    const lo = (embedded & 0xffffn).toString(16);
    normalised = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = normalised.split('::');
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0] ?? '');
  if (head === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const tailGroups = parseGroups(halves[1] ?? '');
    if (tailGroups === null) return null;
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<number>(missing).fill(0), ...tailGroups];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function parseGroups(part: string): number[] | null {
  if (part === '') return [];
  const groups: number[] = [];
  for (const group of part.split(':')) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  return groups;
}

/** `null` when the string is not an address — a hostname, a typo, an empty string. */
export function parseAddress(address: string): ParsedAddress | null {
  const bare = stripBrackets(address.trim());
  const v4 = parseIPv4(bare);
  if (v4 !== null) return { value: v4, bits: V4_BITS };
  const v6 = parseIPv6(bare);
  if (v6 !== null) return { value: v6, bits: V6_BITS };
  return null;
}

function inPrefix(value: bigint, network: bigint, prefix: number, width: number): boolean {
  const shift = BigInt(width - prefix);
  return value >> shift === network >> shift;
}

const BLOCKED_V4: readonly Cidr[] = compileV4([
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
]);

const BLOCKED_V6: readonly Cidr[] = compileV6([
  ['::', 96], // unspecified, loopback, v4-compatible
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]);

/**
 * The top 96 bits of a v4-mapped (`::ffff:a.b.c.d`) address — the `::ffff:0:0/96`
 * prefix, which is numerically just `0xffff` because the 80 bits above it are
 * zero. The `>> 32n` below yields a 96-bit value, so that is what these compare
 * against; writing the NAT64 one as a bare `0x64ff9b` would be a 96-bit compare
 * against a 32-bit constant, which is never true.
 */
const V4_MAPPED_HIGH = 0xffffn;
/** The top 96 bits of a NAT64 (`64:ff9b::a.b.c.d`) address: the `64:ff9b::/96` prefix. */
const NAT64_HIGH = 0x64ff9bn << 64n;

/**
 * True when the string is an address rutekit must not connect to. A string that
 * is not an address at all returns `false` — this is a classification, not a
 * validation, and the caller decides what an unparseable host means.
 */
export function isBlockedAddress(address: string): boolean {
  const parsed = parseAddress(address);
  if (parsed === null) return false;
  if (parsed.bits === V4_BITS) return isBlockedV4(parsed.value);
  return isBlockedV6(parsed.value);
}

function isBlockedV4(value: bigint): boolean {
  return BLOCKED_V4.some((cidr) => inPrefix(value, cidr.value, cidr.prefix, V4_BITS));
}

function isBlockedV6(value: bigint): boolean {
  const high = value >> 32n;
  // A v4 address wearing a v6 costume is still that v4 address.
  if (high === V4_MAPPED_HIGH || high === NAT64_HIGH) {
    return isBlockedV4(value & V4_MASK);
  }
  return BLOCKED_V6.some((cidr) => inPrefix(value, cidr.value, cidr.prefix, V6_BITS));
}

/** Parse `10.0.0.0/8`, `192.168.1.5`, or `fd00::/8`. `null` when malformed. */
export function parseCidr(entry: string): Cidr | null {
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const parsed = parseAddress(address);
  if (parsed === null) return null;
  if (slash === -1) return { ...parsed, prefix: parsed.bits };
  const prefix = Number(entry.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) return null;
  return { ...parsed, prefix };
}

export function cidrContains(cidr: Cidr, address: string): boolean {
  const parsed = parseAddress(address);
  if (parsed === null || parsed.bits !== cidr.bits) return false;
  return inPrefix(parsed.value, cidr.value, cidr.prefix, cidr.bits);
}

export function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

function compileV4(entries: readonly (readonly [string, number])[]): readonly Cidr[] {
  return entries.map(([address, prefix]) => ({
    value: parseIPv4(address) ?? 0n,
    bits: V4_BITS,
    prefix,
  }));
}

function compileV6(entries: readonly (readonly [string, number])[]): readonly Cidr[] {
  return entries.map(([address, prefix]) => ({
    value: parseIPv6(address) ?? 0n,
    bits: V6_BITS,
    prefix,
  }));
}
