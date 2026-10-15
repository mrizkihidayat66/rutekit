import type { Fetcher, HttpResponse } from '@registry';

import type { EgressPolicy } from '@server/security/egress.ts';

/**
 * The one way this server reaches the network (C2).
 *
 * Provider endpoints, OAuth token calls and model discovery all end up here, and
 * the point of that is the guard in front of them: `EgressPolicy` decides whether
 * a URL is one this instance is willing to call at all, and a URL it refuses
 * never reaches a socket. The check runs on the URL as given, so it catches the
 * things a URL can be made to say — a scheme that is not http(s), credentials
 * smuggled into the authority, a literal private address where a hostname should
 * be. What it cannot see is where a hostname resolves to; that check belongs at
 * connect time and is not wired yet, so a hostname is trusted here and the
 * allowlist is the only thing standing behind it.
 *
 * A refusal throws rather than answering with a made-up response. Every caller in
 * this tree already reads a throw as "the call did not happen" and turns it into
 * a message for the operator, so throwing is the shape that costs the least
 * invention at the call site — and it keeps a denial from looking like a provider
 * that answered.
 */

export interface OutboundOptions {
  readonly egress: EgressPolicy;
  /** The transport to delegate to. Injectable so a test needs no network. */
  readonly fetch?: Fetcher;
}

/**
 * Refuse a URL the egress policy will not call.
 *
 * Shared by both fetchers below so the control has one implementation: a probe
 * and a proxied chat call must not be able to disagree about what this instance
 * is willing to reach.
 */
export function guardOutbound(egress: EgressPolicy, url: string): void {
  const decision = egress.checkUrl(url);
  if (!decision.allowed) {
    throw new Error(`the outbound address is not permitted (${decision.reason})`);
  }
}

export function createOutboundFetcher(options: OutboundOptions): Fetcher {
  const delegate = options.fetch ?? globalFetch;
  return async (url, init) => {
    guardOutbound(options.egress, url);
    return delegate(url, init);
  };
}

/**
 * The same guard, over the platform's own response type.
 *
 * The registry's `Fetcher` answers with a status and `text()` and nothing else,
 * which is all a probe needs and not enough for a chat call: a streamed answer
 * has to be read as it arrives, and `text()` would buffer the whole turn before
 * the first byte reached the client. So the data plane gets a second, thinner
 * fetcher that hands back the real `Response` — behind the same check, so
 * neither path can be reached without it.
 */
export type ResponseFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface ResponseFetcherOptions {
  readonly egress: EgressPolicy;
  readonly fetch?: ResponseFetcher;
}

export function createOutboundResponseFetcher(options: ResponseFetcherOptions): ResponseFetcher {
  const delegate = options.fetch ?? globalResponseFetch;
  return async (url, init) => {
    guardOutbound(options.egress, url);
    return delegate(url, init);
  };
}

const globalFetch: Fetcher = (url, init): Promise<HttpResponse> => fetch(url, init);

const globalResponseFetch: ResponseFetcher = (url, init) => fetch(url, init);
