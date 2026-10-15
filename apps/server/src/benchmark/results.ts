import type { BenchmarkResult } from '@contracts';

import type { BenchmarkResultInsert } from '@server/persistence/benchmark.ts';

import { targetKey, type BenchmarkPlan, type PlannedCell } from './config.ts';

/**
 * Reading promptfoo's `results.json` back into cells (C11, FR-9.2).
 *
 * The file is promptfoo's own format, version 3, and the parts this reads are the
 * parts it has kept stable across that version: one row per cell, carrying the
 * prompt it ran, the provider that answered, the response, and the grading.
 * Everything here is defensive about *shape* and strict about *meaning*: a row
 * that does not look like a row is dropped with a reason, and a row that does is
 * read for exactly the six figures the contract has columns for.
 *
 * **`ttftMs` comes from the provider's own metadata, not from promptfoo.** That
 * is the whole reason the thin provider exists (ADR-0017): promptfoo measures a
 * request, and the time to the first token is not a number it has a column for.
 * A missing one is left null rather than guessed from the latency — a first-token
 * time derived from a total would be a figure nobody measured.
 *
 * **A failed cell keeps whatever arrived before it failed.** A provider that
 * answered three hundred characters and then dropped the connection has a real
 * first-token time, and discarding it would hide the fact that the model did
 * start answering — which is the difference between "this model is slow" and
 * "this model is unreachable".
 *
 * **`qualityScore` is promptfoo's `gradingResult.score`**, which is the fraction
 * of assertions that passed. With no rubric there is no grading at all, and the
 * score is null — the contract's own "the run had no scoring rubric".
 *
 * **A cell failed when the *call* failed, not when the rubric did.** This is the
 * one place the two vocabularies nearly collided, and the collision is worth
 * spelling out because both of promptfoo's obvious signals are wrong. It sets
 * `success: false` on any row whose assertions did not all pass, *and* it fills
 * the row's `error` with the failing assertion's reason — so reading either one
 * as "this cell failed" marks every model that answered well without answering
 * perfectly as broken, throws its score away, and leaves the score column
 * reading 1 or nothing. Since comparing models that mostly answer well is the
 * entire point of a rubric, that reading destroys the feature.
 *
 * The signal that does mean what it says is **`response.error`**, which
 * promptfoo sets only when the request itself could not be made. The row's own
 * `error` is kept as the message in that case, and a row with no response at all
 * but an error is treated the same way — that is a cell promptfoo could not even
 * attempt.
 */

/** A row of promptfoo's output, as far as this reads it. */
interface RawRow {
  readonly prompt?: { readonly label?: unknown; readonly raw?: unknown };
  readonly provider?: { readonly label?: unknown; readonly id?: unknown };
  readonly response?: {
    readonly output?: unknown;
    readonly latencyMs?: unknown;
    readonly cost?: unknown;
    readonly metadata?: unknown;
    readonly tokenUsage?: { readonly prompt?: unknown; readonly completion?: unknown };
    /** Set when the request itself could not be made. */
    readonly error?: unknown;
  };
  readonly latencyMs?: unknown;
  readonly cost?: unknown;
  readonly gradingResult?: { readonly score?: unknown };
  /** True only when every assertion passed; see the note at the top. */
  readonly success?: unknown;
  readonly error?: unknown;
}

export interface ParsedResults {
  readonly cells: readonly Omit<BenchmarkResultInsert, 'runId'>[];
  /** Rows that could not be traced to a cell, and why — for the log. */
  readonly unmatched: readonly string[];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The preview a table row shows: one line, clipped. */
const PREVIEW_CHARS = 400;

function previewOf(output: string): string {
  const flat = output.replaceAll(/\s+/gu, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/**
 * The rows of a `results.json`, or an empty list for a document this cannot read.
 *
 * A shape that is not the one expected yields no cells rather than a throw: the
 * caller records the run as failed with the reason, which is a better outcome
 * than a run that fails while trying to describe why it failed.
 */
export function rowsOf(document: unknown): readonly RawRow[] {
  if (document === null || typeof document !== 'object') return [];
  const results = (document as { results?: unknown }).results;
  if (results === null || typeof results !== 'object') return [];
  const rows = (results as { results?: unknown }).results;
  return Array.isArray(rows) ? (rows as RawRow[]) : [];
}

export function parseResults(document: unknown, plan: BenchmarkPlan): ParsedResults {
  // Keyed by the full pair, because a variant appears once per target and a
  // variant-id map alone could not tell which target a row belonged to.
  const byCell = new Map(plan.cells.map((cell) => [cellKey(cell), cell]));
  const cells: Omit<BenchmarkResultInsert, 'runId'>[] = [];
  const unmatched: string[] = [];
  // promptfoo runs a cell once per prompt-provider pair, but a configuration that
  // repeated a pair would produce two rows for one cell. The second is dropped
  // rather than written over the first: the matrix has one answer per cell, and
  // which of two rows was "right" is not something this can know.
  const seen = new Set<string>();

  for (const row of rowsOf(document)) {
    const variantId = str(row.prompt?.label);
    const providerLabel = str(row.provider?.label);
    if (variantId === null || providerLabel === null) {
      unmatched.push('a row carried no prompt or provider label');
      continue;
    }

    const key = `${variantId}::${providerLabel}`;
    const cell = byCell.get(key);
    if (cell === undefined) {
      unmatched.push(`${key} is not a cell this run planned`);
      continue;
    }
    if (seen.has(key)) {
      unmatched.push(`${key} appeared twice`);
      continue;
    }
    seen.add(key);

    const output = str(row.response?.output) ?? '';
    const metadata = (row.response?.metadata ?? {}) as Record<string, unknown>;
    // The *call*, not the rubric — see the note at the top of this file. A row
    // with no response at all is one promptfoo never got to attempt, which is a
    // failure by the same reading.
    const attempted = row.response !== undefined;
    const failed = !attempted || str(row.response?.error) !== null;
    const failure = str(row.response?.error) ?? str(row.error);

    cells.push({
      id: crypto.randomUUID(),
      position: cell.position,
      variantId,
      providerId: cell.target.providerId,
      model: cell.target.model,
      status: failed ? 'failed' : 'succeeded',
      // promptfoo reports the first token time nowhere, which is why the thin
      // provider reports it in `metadata` — a missing one stays null.
      ttftMs: num(metadata['ttftMs']),
      // The whole request, as promptfoo measured it. Deliberately not the sum of
      // anything: it is a different quantity from `ttftMs` and is never combined
      // with it.
      latencyMs: num(row.response?.latencyMs) ?? num(row.latencyMs),
      outputTokens: num(metadata['outputTokens']) ?? num(row.response?.tokenUsage?.completion),
      tokensPerSecond: num(metadata['tokensPerSecond']),
      costUsd: num(row.response?.cost) ?? num(row.cost),
      // Null when there was no rubric: promptfoo grades nothing, so there is no
      // score — which is the contract's own reading of an unscored run.
      qualityScore: failed ? null : num(row.gradingResult?.score),
      outputPreview: previewOf(output),
      error: failed ? (failure ?? 'the cell did not succeed') : null,
    });
  }

  // Any planned cell with no row is a cell promptfoo never reported, which is a
  // real outcome — a run killed part-way — and is written as failed rather than
  // left out, because a table that silently shows fewer cells than were asked
  // for is a table that lies about the run's size.
  for (const planned of plan.cells) {
    const key = cellKey(planned);
    if (seen.has(key)) continue;
    cells.push({
      id: crypto.randomUUID(),
      position: planned.position,
      variantId: planned.variantId,
      providerId: planned.target.providerId,
      model: planned.target.model,
      status: 'failed',
      ttftMs: null,
      latencyMs: null,
      outputTokens: null,
      tokensPerSecond: null,
      costUsd: null,
      qualityScore: null,
      outputPreview: '',
      error: 'promptfoo reported no result for this cell',
    });
  }

  return { cells: cells.sort((a, b) => a.position - b.position), unmatched };
}

/** A planned cell's key, which is also the pair of labels promptfoo reports. */
function cellKey(cell: PlannedCell): string {
  return `${cell.variantId}::${targetKey(cell.target)}`;
}

/** The contract's shape, from a stored row — for a caller that has one. */
export type { BenchmarkResult };
