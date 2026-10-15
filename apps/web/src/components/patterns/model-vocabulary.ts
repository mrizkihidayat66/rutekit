import {
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelSource,
  type ProviderModel,
} from '@contracts';

import { formatUsd } from '@web/lib/format.ts';

import type { VocabularyOption } from './provider-vocabulary.ts';
import type { Tone } from './tone.ts';

/**
 * The Models vocabulary, shared by the two pages that list a model row.
 *
 * Provider Detail lists one provider's models and the Model Catalog lists every
 * provider's, so both need the same four words — where an entry came from, what
 * it can do, and what it costs per million tokens. Spelling them twice would let
 * the two pages describe the same row differently, which is exactly the drift
 * this module exists to prevent.
 *
 * Nothing here renders, so any component may import it without breaking fast
 * refresh.
 */

/* ---- Source ---- */

/**
 * Where a model entry came from, in the operator's words.
 *
 * The distinction earns a column because it is the only thing on the row that
 * decides whether the row can be touched: a model the provider told us about is
 * the provider's claim and rutekit only reports it, while one an operator typed
 * in is theirs to edit. Saying which is which is cheaper than letting someone
 * find out by clicking an edit button that refuses.
 */
export const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  template: 'Catalog',
  synced: 'Synced',
  custom: 'Custom',
};

export const MODEL_SOURCE_TONES: Record<ModelSource, Tone> = {
  template: 'neutral',
  synced: 'info',
  custom: 'accent',
};

export const MODEL_SOURCE_HINTS: Record<ModelSource, string> = {
  template: 'Part of the curated catalog for this provider. Read-only.',
  synced: 'Listed by the endpoint when its models were last fetched. Read-only.',
  custom: 'Added by hand. Only these can be edited or removed.',
};

export const MODEL_SOURCES: readonly ModelSource[] = ['template', 'synced', 'custom'];

export function isModelSource(value: string): value is ModelSource {
  return MODEL_SOURCES.includes(value as ModelSource);
}

/** Only an operator's own entry is rutekit's to change. */
export function isEditableModel(model: ProviderModel): boolean {
  return model.source === 'custom';
}

/* ---- Capabilities ---- */

/** The four flags, in the order a row reads them. */
export const MODEL_CAPABILITY_LABELS: Record<ModelCapability, string> = {
  vision: 'vision',
  tools: 'tools',
  reasoning: 'reasoning',
  embedding: 'embedding',
};

/**
 * What each flag promises, for a filter's tooltip.
 *
 * Written as a capability rather than a definition — "can accept images" is the
 * question an operator is actually asking when they filter on it, where
 * "vision" only names the flag.
 */
export const MODEL_CAPABILITY_HINTS: Record<ModelCapability, string> = {
  vision: 'Accepts images as well as text.',
  tools: 'Can be given callable functions and will answer with calls to them.',
  reasoning: 'Spends tokens thinking before it answers.',
  embedding: 'Returns vectors instead of completions.',
};

export function isModelCapability(value: string): value is ModelCapability {
  return MODEL_CAPABILITIES.includes(value as ModelCapability);
}

/* ---- Price ---- */

/** A per-million-token price — `$2.50/M`. An unpriced model reads as `—`. */
export function formatPerMTok(value: number | null): string {
  return value === null ? '—' : `${formatUsd(value)}/M`;
}

/* ---- Filter option lists ---- */

/**
 * The catalog's two closed filters, each with "all" in front.
 *
 * The `all` row is part of the list rather than a separate sentinel because the
 * URL stores a filter's absence as an absent parameter: `useUrlParam` maps the
 * fallback value back to "no parameter", so the sentinel has to be a value the
 * select can display.
 */
export const MODEL_CAPABILITY_OPTIONS: readonly VocabularyOption<'all' | ModelCapability>[] = [
  { value: 'all', label: 'Any capability' },
  ...MODEL_CAPABILITIES.map((capability) => ({
    value: capability,
    label: MODEL_CAPABILITY_LABELS[capability],
  })),
];

export const MODEL_SOURCE_OPTIONS: readonly VocabularyOption<'all' | ModelSource>[] = [
  { value: 'all', label: 'Any source' },
  ...MODEL_SOURCES.map((source) => ({ value: source, label: MODEL_SOURCE_LABELS[source] })),
];
