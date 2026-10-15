import type { Proxy, ProxyHealth, ProxyProtocol, SortDirection } from '@contracts';

import type { Tone } from '@web/components/patterns/tone.ts';

/**
 * The Proxy Pool page's own vocabulary.
 *
 * Kept out of the components so those files stay components-only for the
 * fast-refresh boundary, and so the table, the toolbar, the dialogs and the
 * summary tiles agree on the handful of things they share: what a filter means
 * before it becomes a query parameter, what each health state is called, and
 * which fields the pool can be ordered by.
 *
 * A filter has to be able to say "do not narrow", and the endpoint's `null` is
 * not something a select can hold — so each one carries its own "any" value,
 * exactly the shape the job history uses.
 */

/** Every protocol a proxy may speak, in the order the form offers them. */
export const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5'];

export const PROXY_PROTOCOL_LABELS: Record<ProxyProtocol, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks5: 'SOCKS5',
};

/** Every health state a proxy may be in, worst-last so the list reads as a scale. */
export const PROXY_HEALTHS: readonly ProxyHealth[] = ['healthy', 'slow', 'dead', 'untested'];

export const PROXY_HEALTH_LABELS: Record<ProxyHealth, string> = {
  healthy: 'Healthy',
  slow: 'Slow',
  dead: 'Dead',
  untested: 'Untested',
};

/**
 * What each state means for the pool.
 *
 * The colour is the same one the summary tile above the table uses, so a row and
 * the tally it contributes to can never be read as two different things.
 */
export const PROXY_HEALTH_TONES: Record<ProxyHealth, Tone> = {
  healthy: 'success',
  slow: 'warning',
  dead: 'danger',
  untested: 'neutral',
};

export const PROXY_HEALTH_HINTS: Record<ProxyHealth, string> = {
  healthy: 'Answered well inside the timeout on the last check.',
  slow: 'Answered, but slowly enough that a sign-in may time out behind it.',
  dead: 'Did not answer. Dispatches through it will fail.',
  untested: 'Never checked, or added since the last sweep.',
};

/** The protocol filter: any protocol, or one of the three. */
export type ProtocolFilter = 'all' | ProxyProtocol;

export const PROTOCOL_FILTERS: readonly ProtocolFilter[] = ['all', ...PROXY_PROTOCOLS];

export function isProtocolFilter(value: string): value is ProtocolFilter {
  return value === 'all' || PROXY_PROTOCOLS.includes(value as ProxyProtocol);
}

/** What the endpoint wants: a real protocol, or null to leave the list whole. */
export function protocolParam(filter: ProtocolFilter): ProxyProtocol | null {
  return filter === 'all' ? null : filter;
}

/** The health filter: any state, or one of the four. */
export type HealthFilter = 'all' | ProxyHealth;

export const HEALTH_FILTERS: readonly HealthFilter[] = ['all', ...PROXY_HEALTHS];

export function isHealthFilter(value: string): value is HealthFilter {
  return value === 'all' || PROXY_HEALTHS.includes(value as ProxyHealth);
}

export function healthParam(filter: HealthFilter): ProxyHealth | null {
  return filter === 'all' ? null : filter;
}

/**
 * What the pool can be ordered by.
 *
 * Health is here and first among the fields that are not the default, because
 * the question this page is opened with is "is anything wrong" — sorting by
 * health puts the dead ones together. Latency answers "which one is fastest",
 * and the dispatch count answers "is anything actually being used".
 */
export const PROXY_SORT_KEYS = [
  'createdAt',
  'health',
  'latencyMs',
  'dispatchCount',
  'lastCheckedAt',
  'host',
] as const;
export type ProxySortKey = (typeof PROXY_SORT_KEYS)[number];

export const DEFAULT_PROXY_SORT: ProxySortKey = 'createdAt';

export function isProxySortKey(value: string): value is ProxySortKey {
  return PROXY_SORT_KEYS.includes(value as ProxySortKey);
}

export const PROXY_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];
export const DEFAULT_PROXY_DIRECTION: SortDirection = 'desc';

export function isProxyDirection(value: string): value is SortDirection {
  return value === 'asc' || value === 'desc';
}

/** A proxy is one row and pools are small, so a page is generous. */
export const PROXY_PAGE_SIZE = 40;

/** Whether anything is narrowing the list, so "Clear filters" can appear. */
export function proxyNarrowed(search: string, protocol: ProtocolFilter, health: HealthFilter): boolean {
  return search.trim() !== '' || protocol !== 'all' || health !== 'all';
}

/** The address as an operator reads it, without the credentials. */
export function proxyAddress(proxy: Proxy): string {
  return `${proxy.host}:${String(proxy.port)}`;
}
