import { describe, expect, it } from 'vitest';

import { EgressPolicy } from '@server/security/egress.ts';
import {
  cidrContains,
  isBlockedAddress,
  parseAddress,
  parseCidr,
  parseIPv4,
  parseIPv6,
  stripBrackets,
} from '@server/security/ip-address.ts';
import { hashPassword, verifyPassword } from '@server/security/password.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { hashToken, mintApiKey, mintSessionToken } from '@server/security/tokens.ts';

/**
 * The C2 security primitives, in isolation.
 *
 * None of these touch a socket or a database, which is exactly why they are
 * tested here rather than through a route: the SSRF table and the envelope
 * format are the parts where a quiet mistake is a vulnerability, and they should
 * fail in a unit test rather than in an integration one that has already had to
 * set up a session to get there.
 */

const SECRET = 'a-32-byte-test-secret-0123456789';

describe('passwords', () => {
  it('round-trips a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct-horse-battery', null);

    expect(await verifyPassword('correct-horse-battery', hash, null)).toBe(true);
    expect(await verifyPassword('correct-horse-battery!', hash, null)).toBe(false);
  });

  it('changes the stored hash when a pepper is configured', async () => {
    const unpeppered = await hashPassword('same-password', null);
    const peppered = await hashPassword('same-password', SECRET);

    // Same password, different stored value — the pepper is doing something.
    expect(peppered).not.toBe(unpeppered);
    expect(await verifyPassword('same-password', peppered, SECRET)).toBe(true);
    // And a hash made with the pepper does not verify without it, which is the
    // property that makes the secret worth setting.
    expect(await verifyPassword('same-password', peppered, null)).toBe(false);
  });

  it('treats a malformed stored hash as a failed login, not a crash', async () => {
    expect(await verifyPassword('anything', 'not-a-phc-string', null)).toBe(false);
  });
});

describe('opaque tokens', () => {
  it('hashes deterministically to hex', () => {
    const hash = hashToken('some-secret');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('some-secret')).toBe(hash);
    expect(hashToken('some-secret-2')).not.toBe(hash);
  });

  it('mints an API key whose stored hash is the hash of the shown secret', () => {
    const key = mintApiKey();

    expect(key.secret.startsWith('rk-')).toBe(true);
    expect(key.prefix).toBe(key.secret.slice(0, 7));
    // The prefix is a head, never the whole key.
    expect(key.prefix.length).toBeLessThan(key.secret.length);
    expect(key.hash).toBe(hashToken(key.secret));
  });

  it('mints a different key every time', () => {
    expect(mintApiKey().secret).not.toBe(mintApiKey().secret);
    expect(mintSessionToken().token).not.toBe(mintSessionToken().token);
  });

  it('mints a session token whose hash is what would be stored', () => {
    const session = mintSessionToken();
    expect(session.token).not.toBe('');
    expect(session.hash).toBe(hashToken(session.token));
  });
});

describe('the secret box', () => {
  const box = new SecretBox('0'.repeat(64));

  it('round-trips a value', () => {
    const envelope = box.encrypt('sk-provider-token');
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(box.decrypt(envelope)).toBe('sk-provider-token');
  });

  it('never encrypts the same plaintext to the same ciphertext', () => {
    // A fresh IV per record; equal envelopes would mean a reused IV, which is
    // the one thing GCM must never do.
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('refuses a tampered envelope rather than returning junk', () => {
    const envelope = box.encrypt('sk-provider-token');
    const parts = envelope.split(':');
    const flipped = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3] === 'AAAA' ? 'BBBB' : 'AAAA'}`;

    expect(() => box.decrypt(flipped)).toThrow();
  });

  it('refuses an envelope from a different key', () => {
    const other = new SecretBox('f'.repeat(64));
    expect(() => other.decrypt(box.encrypt('sk-provider-token'))).toThrow();
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => new SecretBox('abcd')).toThrow(/32 bytes/);
  });
});

describe('address parsing', () => {
  it('parses dotted quads and rejects out-of-range octets', () => {
    expect(parseIPv4('1.2.3.4')).toBe(0x01020304n);
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffffn);
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('1.2.3.4.5')).toBeNull();
  });

  it('parses IPv6 including the compressed and embedded forms', () => {
    expect(parseIPv6('::1')).not.toBeNull();
    expect(parseIPv6('2001:db8::1')).not.toBeNull();
    // A zone id names an interface, not a different address.
    expect(parseIPv6('fe80::1%eth0')).toBe(parseIPv6('fe80::1'));
    expect(parseIPv6('not:an:address')).toBeNull();
  });

  it('classifies a non-address as not-an-address, not as an error', () => {
    expect(parseAddress('example.com')).toBeNull();
    expect(parseAddress('')).toBeNull();
    expect(parseAddress('[::1]')).toEqual(parseAddress('::1'));
  });

  it('strips the brackets a URL host carries around a v6 literal', () => {
    expect(stripBrackets('[::1]')).toBe('::1');
    expect(stripBrackets('example.com')).toBe('example.com');
  });
});

describe('the blocked-address table', () => {
  it('blocks loopback, private, link-local and the metadata endpoint', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows a public address', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
  });

  it('blocks the IPv6 equivalents', () => {
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('fc00::1')).toBe(true);
  });

  it('unwraps a v4 address wearing a v6 costume', () => {
    // Both forms reach the same v4 address, so both must be judged as it.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('64:ff9b::10.0.0.1')).toBe(true);
  });

  it('returns false for something that is not an address at all', () => {
    // Classification, not validation: the caller decides what an unparseable
    // host means.
    expect(isBlockedAddress('example.com')).toBe(false);
  });
});

describe('CIDR matching', () => {
  it('parses a network and matches inside it', () => {
    const cidr = parseCidr('10.0.0.0/8');
    expect(cidr).not.toBeNull();
    if (cidr === null) return;

    expect(cidrContains(cidr, '10.255.255.255')).toBe(true);
    expect(cidrContains(cidr, '11.0.0.1')).toBe(false);
  });

  it('treats a bare address as a single-host network', () => {
    const cidr = parseCidr('192.168.1.5');
    expect(cidr?.prefix).toBe(32);
    expect(cidr !== null && cidrContains(cidr, '192.168.1.5')).toBe(true);
  });

  it('rejects a malformed entry', () => {
    expect(parseCidr('not-a-network')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/-1')).toBeNull();
  });

  it('does not match across families', () => {
    const cidr = parseCidr('10.0.0.0/8');
    expect(cidr !== null && cidrContains(cidr, '::1')).toBe(false);
  });
});

describe('the egress policy', () => {
  const policy = new EgressPolicy();

  it('accepts an http(s) URL and refuses anything else', () => {
    expect(policy.checkUrl('https://api.example.com/v1')).toEqual({ allowed: true });
    expect(policy.checkUrl('http://api.example.com')).toEqual({ allowed: true });
    expect(policy.checkUrl('ftp://api.example.com')).toEqual({
      allowed: false,
      reason: 'unsupported-scheme',
    });
  });

  it('refuses a URL that is not a URL, and one with embedded credentials', () => {
    expect(policy.checkUrl('not a url')).toEqual({ allowed: false, reason: 'invalid-url' });
    expect(policy.checkUrl('https://user:pass@api.example.com')).toEqual({
      allowed: false,
      reason: 'embedded-credentials',
    });
  });

  it('refuses a literal private host but lets a hostname through unresolved', () => {
    // A hostname is not resolved at creation: the answer that matters is the one
    // at connect time, and resolving twice would race.
    expect(policy.checkUrl('http://127.0.0.1:8080')).toEqual({
      allowed: false,
      reason: 'blocked-address',
    });
    expect(policy.checkUrl('http://[::1]:8080')).toEqual({
      allowed: false,
      reason: 'blocked-address',
    });
    expect(policy.checkUrl('http://internal.example.com')).toEqual({ allowed: true });
  });

  it('fails closed at connect time', () => {
    expect(policy.checkAddress('169.254.169.254')).toEqual({
      allowed: false,
      reason: 'blocked-address',
    });
    expect(policy.checkAddress('nonsense')).toEqual({ allowed: false, reason: 'invalid-address' });
    expect(policy.checkAddress('93.184.216.34')).toEqual({ allowed: true });
  });

  it('reaches a private network only when the operator names it', () => {
    const scoped = new EgressPolicy(['10.0.0.0/8']);

    expect(scoped.checkAddress('10.1.2.3')).toEqual({ allowed: true });
    expect(scoped.checkUrl('http://10.1.2.3')).toEqual({ allowed: true });
    // The allowlist is exactly that network, not the whole private space.
    expect(scoped.checkAddress('192.168.1.1')).toEqual({
      allowed: false,
      reason: 'blocked-address',
    });
  });

  it('refuses to construct with a malformed allowlist entry', () => {
    // A typo in a security allowlist must be loud, not silently dropped.
    expect(() => new EgressPolicy(['not-a-network'])).toThrow(/invalid egress allowlist/);
  });
});
