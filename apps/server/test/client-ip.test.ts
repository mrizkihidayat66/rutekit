import { describe, expect, it } from 'vitest';

import { deriveClientIp, isLoopbackAddress } from '@server/ingress/client-ip.ts';

/**
 * Who the server thinks is calling (A24).
 *
 * Every one of these cases is a way an attacker could claim to be someone else:
 * `X-Forwarded-For` is just a header, so honouring it when the socket peer is
 * not a local proxy hands the abuse counter and the login throttle to whoever
 * sends the header.
 */

describe('isLoopbackAddress', () => {
  it('recognises the IPv4 and IPv6 loopback forms', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.53')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('localhost')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    // A bare `127` with no dot is not the loopback range — the check is on the
    // `127.` prefix, and a socket peer is always a literal address, never a
    // hostname that could be made to start with it.
    expect(isLoopbackAddress('127')).toBe(false);
    expect(isLoopbackAddress('128.0.0.1')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('deriveClientIp', () => {
  it('reports an unknown peer rather than inventing an address', () => {
    expect(deriveClientIp(undefined, null)).toBe('unknown');
    expect(deriveClientIp('', null)).toBe('unknown');
    expect(deriveClientIp(undefined, '203.0.113.9')).toBe('unknown');
  });

  it('uses the socket peer when it is not loopback', () => {
    // The peer is the authority. A header cannot override it.
    expect(deriveClientIp('198.51.100.7', null)).toBe('198.51.100.7');
  });

  it('ignores X-Forwarded-For from a non-loopback peer', () => {
    // The whole point: a remote caller sending this header is claiming an
    // identity it does not have.
    expect(deriveClientIp('198.51.100.7', '203.0.113.9')).toBe('198.51.100.7');
    expect(deriveClientIp('198.51.100.7', '10.0.0.1, 203.0.113.9')).toBe('198.51.100.7');
  });

  it('believes X-Forwarded-For from a loopback peer', () => {
    // A proxy on the same host is the one case where the header is trustworthy.
    expect(deriveClientIp('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(deriveClientIp('::1', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('takes the leftmost entry, which is the original client', () => {
    expect(deriveClientIp('127.0.0.1', '203.0.113.9, 10.0.0.1, 10.0.0.2')).toBe('203.0.113.9');
    expect(deriveClientIp('127.0.0.1', '  203.0.113.9 , 10.0.0.1 ')).toBe('203.0.113.9');
  });

  it('falls back to the peer when the header carries nothing usable', () => {
    expect(deriveClientIp('127.0.0.1', '')).toBe('127.0.0.1');
    expect(deriveClientIp('127.0.0.1', '   ')).toBe('127.0.0.1');
    expect(deriveClientIp('127.0.0.1', ',')).toBe('127.0.0.1');
  });
});
