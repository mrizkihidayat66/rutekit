import { describe, expect, it } from 'vitest';

import {
  credentialOf,
  parseProxyLine,
  proxyUrl,
  readCredential,
} from '@server/automation/proxy-line.ts';

/**
 * Reading a bulk proxy paste (C7a, FR-5.x).
 *
 * A paste is the one input in this section that the operator did not write: it
 * comes from whoever sold them the proxies, in whatever shape that seller uses.
 * So the parser is tested against the shapes that actually turn up — bare
 * `host:port`, a scheme, credentials, a bracketed IPv6 literal, a password with a
 * colon in it — and against the ones that are genuinely malformed, because the
 * whole reason the result is a sentence rather than a boolean is that it is shown
 * back against a line number.
 */

describe('a bare host and port', () => {
  it('reads as plain http', () => {
    const result = parseProxyLine('203.0.113.10:8080');

    expect(result).toEqual({
      ok: true,
      proxy: { protocol: 'http', host: '203.0.113.10', port: 8080, username: null, password: null },
    });
  });

  it('trims surrounding whitespace, which a paste always has', () => {
    const result = parseProxyLine('  203.0.113.10:8080\t');
    expect(result.ok).toBe(true);
  });
});

describe('a scheme', () => {
  it.each([
    ['http://203.0.113.10:8080', 'http'],
    ['https://203.0.113.10:8080', 'https'],
    ['socks5://203.0.113.10:1080', 'socks5'],
  ] as const)('reads %s as %s', (line, protocol) => {
    const result = parseProxyLine(line);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy.protocol).toBe(protocol);
    expect(result.proxy.host).toBe('203.0.113.10');
  });

  it('accepts a scheme in any casing', () => {
    const result = parseProxyLine('SOCKS5://203.0.113.10:1080');
    expect(result.ok && result.proxy.protocol).toBe('socks5');
  });
});

describe('credentials', () => {
  it('splits user and password out of the authority', () => {
    const result = parseProxyLine('http://alice:hunter2@203.0.113.10:8080');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy.username).toBe('alice');
    expect(result.proxy.password).toBe('hunter2');
    expect(result.proxy.host).toBe('203.0.113.10');
    expect(result.proxy.port).toBe(8080);
  });

  it('keeps a password that contains an @ intact', () => {
    // A generated password routinely contains one, and splitting on the *first*
    // `@` would fold the rest of the password into the host — producing a proxy
    // that connects to nothing.
    const result = parseProxyLine('http://alice:p@ss@203.0.113.10:8080');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy.username).toBe('alice');
    expect(result.proxy.password).toBe('p@ss');
    expect(result.proxy.host).toBe('203.0.113.10');
  });

  it('keeps a password that contains a colon intact', () => {
    // The same failure from the other direction: the port separator is looked
    // for from the right, so a colon in the password cannot be mistaken for it.
    const result = parseProxyLine('http://alice:a:b:c@203.0.113.10:8080');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy.password).toBe('a:b:c');
    expect(result.proxy.port).toBe(8080);
  });

  it('reads a username with no password', () => {
    const result = parseProxyLine('http://alice@203.0.113.10:8080');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy.username).toBe('alice');
    expect(result.proxy.password).toBeNull();
  });
});

describe('a bracketed IPv6 literal', () => {
  it('keeps the address whole and finds the port after the bracket', () => {
    // Without bracket handling the last-colon rule would read `:1080` as the port
    // and leave `2001:db8::1:9` as the host, which is not an address at all.
    const result = parseProxyLine('socks5://[2001:db8::1]:1080');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy.host).toBe('2001:db8::1');
    expect(result.proxy.port).toBe(1080);
  });

  it('reads credentials in front of a bracketed literal', () => {
    const result = parseProxyLine('http://alice:pw@[2001:db8::1]:8080');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy.username).toBe('alice');
    expect(result.proxy.host).toBe('2001:db8::1');
    expect(result.proxy.port).toBe(8080);
  });
});

describe('the malformed lines', () => {
  it('names the problem rather than answering with a boolean', () => {
    // The message is shown back against a line number, so it has to be a sentence
    // the operator can act on.
    const cases: readonly [string, string][] = [
      ['203.0.113.10', 'no port'],
      [':8080', 'no host'],
      ['203.0.113.10:0', 'port must be'],
      ['203.0.113.10:70000', 'port must be'],
      ['203.0.113.10:abc', 'port must be'],
      ['ftp://203.0.113.10:21', 'unknown scheme'],
      ['', 'empty line'],
    ];

    for (const [line, fragment] of cases) {
      const result = parseProxyLine(line);
      expect(result.ok, line).toBe(false);
      if (result.ok) continue;
      expect(result.error, line).toContain(fragment);
    }
  });

  it('reports an empty line as its own failure, so the caller can skip it', () => {
    // The caller filters blank lines before parsing, but a parser that answered
    // `ok` for one would let an empty entry into the pool.
    expect(parseProxyLine('   ').ok).toBe(false);
  });
});

describe('the credential as stored', () => {
  it('round-trips through JSON, which is why it is not `user:pass`', () => {
    const parsed = parseProxyLine('http://alice:a:b@203.0.113.10:8080');
    if (!parsed.ok) throw new Error('expected a parsed proxy');

    const stored = credentialOf(parsed.proxy);
    expect(stored).not.toBeNull();
    expect(readCredential(stored ?? '')).toEqual({ username: 'alice', password: 'a:b' });
  });

  it('is null when the line named no credentials', () => {
    const parsed = parseProxyLine('203.0.113.10:8080');
    if (!parsed.ok) throw new Error('expected a parsed proxy');
    expect(credentialOf(parsed.proxy)).toBeNull();
  });

  it('reads null back out of an unreadable envelope rather than throwing', () => {
    expect(readCredential('not json')).toBeNull();
    expect(readCredential(JSON.stringify({ username: '', password: '' }))).toBeNull();
  });
});

describe('the proxy URL a client connects through', () => {
  it('percent-encodes credentials, so a special character cannot move the host', () => {
    // A password with an `@` or a `/` in it would otherwise change where the URL
    // points — the same class of bug the right-to-left split exists to avoid.
    const parsed = parseProxyLine('http://alice:p@ss/word@203.0.113.10:8080');
    if (!parsed.ok) throw new Error('expected a parsed proxy');

    expect(proxyUrl(parsed.proxy)).toBe('http://alice:p%40ss%2Fword@203.0.113.10:8080');
  });

  it('omits the authority when there are no credentials', () => {
    const parsed = parseProxyLine('socks5://203.0.113.10:1080');
    if (!parsed.ok) throw new Error('expected a parsed proxy');

    expect(proxyUrl(parsed.proxy)).toBe('socks5://203.0.113.10:1080');
  });
});
