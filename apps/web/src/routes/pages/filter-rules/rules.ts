import type { FilterRule, SortDirection } from '@contracts';

import type { Tone } from '@web/components/patterns/tone.ts';
import type { EnabledFilter } from '@web/lib/list-filters.ts';

/**
 * The filter rules' shared vocabulary.
 *
 * Kept out of the components so those files stay components-only for the
 * fast-refresh boundary, and so the page and its dialog agree on what each
 * choice means.
 *
 * A rule is the one part of routing that runs before the router has decided
 * anything. A mapping renames a model on its way out; a combo chooses which
 * endpoint answers; a filter rule looks at the request as it arrived and either
 * stops it or rewrites the part that matched. That is why it is filed under
 * Routing rather than among the by-hand tools — it is not a job somebody runs,
 * it is a rule every request passes through.
 */

/**
 * The two halves of a rule's shape, taken off the contract rather than restated.
 *
 * `FilterRule` carries them as inline enums, so there is no named type to import;
 * deriving them here means a change to the schema breaks this file at compile
 * time instead of letting the two drift apart.
 */
export type FilterKind = FilterRule['kind'];
export type FilterAction = FilterRule['action'];

export const FILTER_KINDS: readonly FilterKind[] = ['regex', 'exact'];

export const FILTER_KIND_LABELS: Record<FilterKind, string> = {
  regex: 'Regular expression',
  exact: 'Exact string',
};

export const FILTER_KIND_HINTS: Record<FilterKind, string> = {
  regex: 'Matched with the router’s regular-expression engine. Anchors are up to you.',
  exact: 'Matched literally, character for character. Cheaper, and impossible to get wrong.',
};

export const FILTER_ACTIONS: readonly FilterAction[] = ['block', 'redact'];

export const FILTER_ACTION_LABELS: Record<FilterAction, string> = {
  block: 'Block',
  redact: 'Redact',
};

export const FILTER_ACTION_TONES: Record<FilterAction, Tone> = {
  block: 'danger',
  redact: 'warning',
};

export const FILTER_ACTION_HINTS: Record<FilterAction, string> = {
  block: 'The request is rejected outright and never reaches a provider.',
  redact: 'The match is replaced before the request goes on its way.',
};

/** The two phases a rule can run in. `1` is before compression, `2` after (FR-11.3). */
export const FILTER_PHASES = [1, 2] as const;
export type FilterPhase = (typeof FILTER_PHASES)[number];

export const FILTER_PHASE_LABELS: Record<FilterPhase, string> = {
  1: 'Before compression',
  2: 'After compression',
};

export const FILTER_PHASE_HINTS: Record<FilterPhase, string> = {
  1: 'Runs on the request as the client sent it, before anything is compacted.',
  2: 'Runs on the compacted request, so it sees what the provider will actually receive.',
};

export function isFilterPhase(value: number): value is FilterPhase {
  return value === 1 || value === 2;
}

/** A phase as the table prints it, tolerating a value the contract does not list. */
export function phaseLabel(phase: number): string {
  return isFilterPhase(phase) ? FILTER_PHASE_LABELS[phase] : `Phase ${String(phase)}`;
}

export const FILTER_SORT_KEYS = ['createdAt', 'name', 'phase', 'action'] as const;
export type FilterSortKey = (typeof FILTER_SORT_KEYS)[number];

export const DEFAULT_FILTER_SORT: FilterSortKey = 'createdAt';

export function isFilterSortKey(value: string): value is FilterSortKey {
  return FILTER_SORT_KEYS.includes(value as FilterSortKey);
}

export const FILTER_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

export function isFilterDirection(value: string): value is SortDirection {
  return value === 'asc' || value === 'desc';
}

/** Rules are a short list that a person maintains by hand, so a page is generous. */
export const FILTER_PAGE_SIZE = 40;

/** Whether anything is narrowing the rule list, so "Clear filters" can appear. */
export function filterNarrowed(search: string, enabled: EnabledFilter): boolean {
  return search.trim() !== '' || enabled !== 'all';
}
