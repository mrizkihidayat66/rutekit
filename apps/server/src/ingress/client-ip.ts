import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

/**
 * Deriving the client address safely (A24).
 *
 * `X-Forwarded-For` is a request header, so anyone can send one. Trusting it
 * unconditionally means any caller can claim to be any address — which defeats
 * the per-IP abuse counter, the login throttle, and every audit line that names
 * a source. So the header is honoured only when the *socket* peer is loopback:
 * that is the one case where a proxy is definitely in front (the operator's own
 * reverse proxy on the same host). Behind a proxy on another host the peer is
 * that proxy, and the header is ignored rather than believed.
 */

const LOOPBACK_EXACT = new Set(['::1', '::ffff:127.0.0.1', 'localhost']);

export function isLoopbackAddress(address: string): boolean {
  return LOOPBACK_EXACT.has(address) || address.startsWith('127.');
}

/** `unknown` when the runtime cannot report a peer — never a fabricated address. */
export function deriveClientIp(
  peerAddress: string | undefined,
  forwardedFor: string | null,
): string {
  if (peerAddress === undefined || peerAddress === '') return 'unknown';
  if (!isLoopbackAddress(peerAddress)) return peerAddress;
  if (forwardedFor === null) return peerAddress;
  // The leftmost entry is the original client; everything after it is a proxy.
  const first = forwardedFor.split(',')[0]?.trim();
  return first !== undefined && first !== '' ? first : peerAddress;
}

/**
 * The socket peer. `getConnInfo` reads Bun's server object, which does not exist
 * under a test runner, so a missing value degrades to `undefined` — the caller
 * then treats the request as coming from an unknown peer instead of crashing a
 * request over a header.
 */
export function peerAddress(c: Context): string | undefined {
  try {
    const address = getConnInfo(c).remote.address;
    return typeof address === 'string' && address !== '' ? address : undefined;
  } catch {
    return undefined;
  }
}
