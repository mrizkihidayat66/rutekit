import type {
  Combo,
  ComboEntry,
  ComboEntryInput,
  LoadBalanceStrategy,
  SortDirection,
} from '@contracts';

/**
 * The Combos & Routes page's vocabulary.
 *
 * Both halves of this page answer one question — what does a client's model name
 * actually resolve to — so their words live together. A combo fans one name out
 * across several candidates; an alias collapses one name onto a single real id.
 * They are the same idea at two levels of ambition, which is why they share a
 * page rather than getting one each.
 *
 * Nothing here renders, so any component on the page may import it without
 * breaking fast refresh.
 */

/* ---- Tabs ---- */

export const COMBO_TABS = ['combos', 'aliases'] as const;
export type ComboTab = (typeof COMBO_TABS)[number];

export const COMBO_TAB_LABELS: Record<ComboTab, string> = {
  combos: 'Combos',
  aliases: 'Aliases',
};

/* ---- Strategy ---- */

export const STRATEGY_LABELS: Record<LoadBalanceStrategy, string> = {
  sequential: 'Sequential',
  round_robin: 'Round robin',
};

/** What each strategy does with the entry list, in one line. */
export const STRATEGY_HINTS: Record<LoadBalanceStrategy, string> = {
  sequential: 'Always starts at the first entry and works down the list.',
  round_robin: 'Picks among the enabled entries in proportion to their weight.',
};

export const STRATEGY_OPTIONS: readonly { value: LoadBalanceStrategy; label: string }[] = [
  { value: 'sequential', label: STRATEGY_LABELS.sequential },
  { value: 'round_robin', label: STRATEGY_LABELS.round_robin },
];

/* ---- Sorting ---- */

/**
 * The sortable fields, per tab.
 *
 * The two halves of the page are different records with different field names —
 * a combo sorts on `name`, an alias on `alias` — and the sort key travels to the
 * endpoint as a bare field name, so a shared vocabulary would send `name` to the
 * alias list and order it by a field that does not exist. Each tab therefore
 * declares its own, and the page resets the sort when the tab changes.
 */
export const COMBO_SORT_KEYS = ['name', 'updatedAt'] as const;
export type ComboSortKey = (typeof COMBO_SORT_KEYS)[number];

export const ALIAS_SORT_KEYS = ['alias', 'updatedAt'] as const;
export type AliasSortKey = (typeof ALIAS_SORT_KEYS)[number];

export type RouteSortKey = ComboSortKey | AliasSortKey;

export const DEFAULT_ROUTE_DIRECTION: SortDirection = 'asc';

export const ROUTE_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

/** The sortable fields for a tab, as the URL parser and the table both see them. */
export function sortKeysForTab(tab: ComboTab): readonly RouteSortKey[] {
  return tab === 'combos' ? COMBO_SORT_KEYS : ALIAS_SORT_KEYS;
}

/** The field a tab sorts on before the operator picks another. */
export function defaultSortForTab(tab: ComboTab): RouteSortKey {
  return tab === 'combos' ? 'name' : 'alias';
}

export function isRouteSortKey(value: string, tab: ComboTab): value is RouteSortKey {
  return sortKeysForTab(tab).includes(value as RouteSortKey);
}

export function isRouteDirection(value: string): value is SortDirection {
  return ROUTE_DIRECTIONS.includes(value as SortDirection);
}

/**
 * How many rows a page holds. Combos and aliases are configuration, not
 * population: a router with more than a couple of dozen of either is unusual, so
 * one page is normally everything and the cap only bounds the pathological case.
 */
export const ROUTE_PAGE_SIZE = 50;

/* ---- Slugs ---- */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mirrors `slugSchema` from the contracts, so the form can refuse before it posts. */
export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/* ---- Entry drafts ---- */

/**
 * One editable row of a combo's chain.
 *
 * Every field is a string because this is form state: a number input that the
 * operator is halfway through typing holds `''` or `'1.'`, neither of which is a
 * number, and coercing on every keystroke would fight the person typing. The
 * conversion happens once, on submit.
 *
 * `key` is the row's identity across reorders. It is deliberately not the
 * entry's server id: a row that has never been saved has no id, and reusing the
 * id would make React remount the input the moment a save round-trips.
 */
export interface EntryDraft {
  readonly key: string;
  readonly model: string;
  readonly providerId: string;
  readonly weight: string;
  readonly enabled: boolean;
}

let entryCounter = 0;

/** A fresh draft. The counter only has to be unique within one open dialog. */
export function newEntryDraft(): EntryDraft {
  entryCounter += 1;
  return {
    key: `entry-${String(entryCounter)}`,
    model: '',
    providerId: '',
    weight: '1',
    enabled: true,
  };
}

export function draftFromEntry(entry: ComboEntry): EntryDraft {
  entryCounter += 1;
  return {
    key: `entry-${String(entryCounter)}`,
    model: entry.model,
    providerId: entry.providerId ?? '',
    weight: String(entry.weight),
    enabled: entry.enabled,
  };
}

export function draftFromCombo(combo: Combo): EntryDraft[] {
  return combo.entries.map(draftFromEntry);
}

/** A positive weight, or `undefined` when the text is not one. */
export function parseWeight(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** The body an entry draft posts. `undefined` means the row is not sendable yet. */
export function inputFromDraft(draft: EntryDraft): ComboEntryInput | undefined {
  const model = draft.model.trim();
  if (model === '') return undefined;
  const weight = parseWeight(draft.weight);
  if (weight === undefined) return undefined;
  return {
    model,
    providerId: draft.providerId === '' ? null : draft.providerId,
    weight,
    enabled: draft.enabled,
  };
}

/**
 * How a combo's chain reads on its card: the models in order, which is the one
 * thing about a combo that cannot be inferred from its name.
 */
export function chainModels(combo: Combo): string[] {
  return combo.entries.map((entry) => entry.model);
}
