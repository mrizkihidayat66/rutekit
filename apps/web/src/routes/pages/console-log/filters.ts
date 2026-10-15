import type { LogKind, LogLevel } from '@contracts';

/**
 * The Console Log page's vocabulary.
 *
 * Which levels and kinds the operator may filter by, and how the page is tuned,
 * in one file so the URL parser, the level tabs and the kind select agree on what
 * a value means. Nothing here renders, so any of the page's parts can import it
 * without breaking fast refresh.
 *
 * Each list is also the allow-list the URL is read against: a hand-edited
 * `?level=` naming something else falls back to the default rather than leaving
 * the page on a filter nothing can satisfy. `all` is the page's own word for "no
 * filter" — the contract's levels and kinds are exactly the rest.
 */

/** Levels in the order the tabs read, widest first. */
export const LEVEL_FILTERS = ['all', 'debug', 'info', 'warn', 'error'] as const satisfies readonly (LogLevel | 'all')[];
export type LevelFilter = (typeof LEVEL_FILTERS)[number];

export const KIND_FILTERS = [
  'all',
  'route',
  'account',
  'token',
  'error',
  'system',
] as const satisfies readonly (LogKind | 'all')[];
export type KindFilter = (typeof KIND_FILTERS)[number];

export const LEVEL_LABELS: Record<LevelFilter, string> = {
  all: 'All',
  debug: 'Debug',
  info: 'Info',
  warn: 'Warn',
  error: 'Error',
};

export const KIND_LABELS: Record<KindFilter, string> = {
  all: 'All kinds',
  route: 'Routing',
  account: 'Accounts',
  token: 'Tokens',
  error: 'Errors',
  system: 'System',
};

export const KIND_OPTIONS = KIND_FILTERS.map((value) => ({ value, label: KIND_LABELS[value] }));

/** Narrows what a select hands back — it deals in plain strings — to a known kind. */
export function isKindFilter(value: string): value is KindFilter {
  return (KIND_FILTERS as readonly string[]).includes(value);
}

/**
 * Counts to show before the first page lands. Zeroed rather than blank so the
 * tabs keep their width and the skeleton below is not the only thing that moves.
 */
export const EMPTY_COUNTS: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 0,
  warn: 0,
  error: 0,
};

/** A log reads better with a longer page than the contract's default of 50. */
export const PAGE_SIZE = 100;

/** How often a followed tail pulls the head. */
export const FOLLOW_MS = 5_000;
