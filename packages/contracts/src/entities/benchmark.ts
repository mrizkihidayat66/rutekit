import { z } from 'zod';
import { isoDateTimeSchema } from '../common.ts';

/**
 * Benchmark runs a multi-variant template test (FR-9.1): one template prompt is
 * expanded into N variants, each sent to M provider/model pairs. Every cell of
 * that matrix is one result row.
 */
export const benchmarkRunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export const benchmarkTargetSchema = z.object({
  providerId: z.string(),
  model: z.string(),
});

export const benchmarkVariantSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** The concrete prompt after template substitution. */
  prompt: z.string(),
  variables: z.record(z.string(), z.string()).default({}),
});

export const benchmarkResultSchema = z.object({
  id: z.string(),
  variantId: z.string(),
  providerId: z.string(),
  model: z.string(),
  status: benchmarkRunStatusSchema,
  ttftMs: z.number().nonnegative().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  tokensPerSecond: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  /** 0–1 quality score; null when the run had no scoring rubric. */
  qualityScore: z.number().min(0).max(1).nullable(),
  /** Truncated for the table; the full text is fetched on demand. */
  outputPreview: z.string(),
  error: z.string().nullable(),
});

/**
 * One check a cell's answer is scored against (FR-9.2's quality score).
 *
 * The kinds are the three a person actually writes when comparing models, and
 * they are deliberately not promptfoo's own vocabulary: rutekit owns the
 * contract and maps onto whatever engine runs it, so a run's rubric survives the
 * engine being replaced.
 *
 * `contains` and `regex` are per-assertion passes; `max_length` is a ceiling on
 * the answer. Each contributes equally to the cell's score, which is the
 * fraction that passed — so a rubric with three checks yields 0, ⅓, ⅔ or 1, and
 * a cell's score means "how much of what was asked for came back".
 */
export const benchmarkAssertionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('contains'),
    /** The substring the answer must contain. */
    value: z.string().min(1),
  }),
  z.object({
    kind: z.literal('regex'),
    /** A pattern the answer must match somewhere. */
    value: z.string().min(1),
  }),
  z.object({
    kind: z.literal('max_length'),
    /** Longest acceptable answer, in characters. */
    value: z.number().int().positive(),
  }),
]);

export const benchmarkRunSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: benchmarkRunStatusSchema,
  template: z.string(),
  variants: z.array(benchmarkVariantSchema),
  targets: z.array(benchmarkTargetSchema),
  results: z.array(benchmarkResultSchema),
  /** Number of results expected when the run finishes. */
  expectedResultCount: z.number().int().nonnegative(),
  /** Optional system prompt applied to every variant. */
  systemPrompt: z.string().nullable(),
  /** What each cell is scored against; empty when the run has no rubric. */
  rubric: z.array(benchmarkAssertionSchema).default([]),
  /**
   * Why the run failed as a whole, when it did.
   *
   * A per-cell error says what one endpoint did; this says what happened to the
   * *experiment* — promptfoo not being installed, a config it refused, a run that
   * ran out of time. Without it a failed run is a row with no explanation, which
   * is the least useful shape a failure can take.
   */
  error: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});

/**
 * A run without its cells, for the list.
 *
 * The list is a table of runs — name, status, how many cells have landed — while
 * the cells are the whole matrix flattened into one row each. Carrying them made
 * one page of twenty runs a few hundred kilobytes of output that nothing on the
 * page reads, so the list answers with a count and the detail answers with rows.
 */
export const benchmarkSummarySchema = benchmarkRunSchema
  .omit({ results: true })
  .extend({ resultCount: z.number().int().nonnegative() });

export type BenchmarkRunStatus = z.infer<typeof benchmarkRunStatusSchema>;
export type BenchmarkTarget = z.infer<typeof benchmarkTargetSchema>;
export type BenchmarkVariant = z.infer<typeof benchmarkVariantSchema>;
export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>;
export type BenchmarkAssertion = z.infer<typeof benchmarkAssertionSchema>;
export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>;
export type BenchmarkSummary = z.infer<typeof benchmarkSummarySchema>;
