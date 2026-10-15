import type {
  BenchmarkAssertion,
  BenchmarkInput,
  BenchmarkResult,
  BenchmarkRun,
  BenchmarkRunStatus,
  BenchmarkTarget,
  BenchmarkVariantInput,
} from '@contracts';

import type { Tone } from '@web/components/patterns/tone.ts';
import { formatCount } from '@web/lib/format.ts';

/**
 * Benchmark vocabulary, template expansion and export.
 *
 * A run is a matrix: N variants of one template, each sent to M provider/model
 * pairs, and `benchmarkRunSchema.results` is that matrix flattened into one row
 * per cell. Everything in this file works on that flattening — reading a cell,
 * grouping cells by target, turning the cells back into a file — so the page
 * and its parts never have to re-derive it.
 *
 * The one rule that shapes the whole page lives here rather than in a comment
 * somewhere: **a cell's time to first token and its total latency are different
 * quantities** (ADR-0017). They are carried in separate fields, aggregated into
 * separate columns and drawn in separate lists, and nothing in this file ever
 * adds them or averages them together.
 */

/* ---- URL ---- */

/** The run whose detail is open, so a result set is a link. */
export const RUN_PARAM = 'run';
export const SEARCH_PARAM = 'bench_q';
/** Set while the composer is open, so opening it is a step the back button undoes. */
export const COMPOSE_PARAM = 'new';

/* ---- Run status ---- */

export const RUN_STATUS_LABELS: Record<BenchmarkRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const RUN_STATUS_TONES: Record<BenchmarkRunStatus, Tone> = {
  queued: 'neutral',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/** A run in one of these states is still filling in its cells. */
export function isLiveRun(status: BenchmarkRunStatus): boolean {
  return status === 'queued' || status === 'running';
}

/* ---- Template expansion ---- */

/**
 * The most variants one template may expand to.
 *
 * The editor multiplies comma-separated values, so a template with five
 * variables and four values each is already a thousand cells across five
 * endpoints. The cap keeps a slip of the keyboard from queueing a run nobody
 * meant to ask for; what was dropped is stated in the editor rather than
 * silently discarded.
 */
export const MAX_VARIANTS = 24;

const PLACEHOLDER = String.raw`\{\{\s*([\w.-]+)\s*\}\}`;

/** The variable names a template uses, in the order they first appear. */
export function templateVariables(template: string): readonly string[] {
  const pattern = new RegExp(PLACEHOLDER, 'g');
  const names: string[] = [];
  for (const match of template.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

function splitValues(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function substitute(template: string, variables: Readonly<Record<string, string>>): string {
  const pattern = new RegExp(PLACEHOLDER, 'g');
  return template.replace(pattern, (match: string, name: string) => variables[name] ?? match);
}

function variantLabel(
  template: string,
  index: number,
  variables: Readonly<Record<string, string>> | null,
): string {
  if (variables !== null) {
    const values = Object.values(variables);
    if (values.length > 0) return clip(values.join(' · '), 60);
  }
  const line = (template.trim().split('\n')[0] ?? '').trim();
  return line === '' ? `Variant ${String(index)}` : clip(line, 48);
}

export interface VariantPlan {
  readonly variants: readonly BenchmarkVariantInput[];
  /** How many combinations the values produced before the cap was applied. */
  readonly total: number;
  readonly capped: boolean;
  /** Variables that were left blank and therefore not expanded. */
  readonly skipped: readonly string[];
}

/**
 * Expand a template and its values into the variants to send.
 *
 * A variable with no values is *not* expanded — its placeholder stays in the
 * prompt instead of being replaced with an empty string. Replacing it would
 * change what the endpoint is asked without anyone saying so, and two runs would
 * then be incomparable for a reason nobody could see. A template with no
 * placeholders at all is one variant, which is the honest reading of it.
 */
export function planVariants(
  template: string,
  rawValues: Readonly<Record<string, string>>,
): VariantPlan {
  const body = template.trim();
  if (body === '') return { variants: [], total: 0, capped: false, skipped: [] };

  const axes = templateVariables(body).map((name) => ({
    name,
    values: splitValues(rawValues[name] ?? ''),
  }));
  const expanded = axes.filter((axis) => axis.values.length > 0);
  const skipped = axes.filter((axis) => axis.values.length === 0).map((axis) => axis.name);

  if (expanded.length === 0) {
    return {
      variants: [{ label: variantLabel(body, 1, null), prompt: body, variables: {} }],
      total: 1,
      capped: false,
      skipped,
    };
  }

  const combinations: Record<string, string>[] = [];
  const walk = (index: number, current: Record<string, string>): void => {
    if (combinations.length >= MAX_VARIANTS) return;
    if (index === expanded.length) {
      combinations.push({ ...current });
      return;
    }
    const axis = expanded[index];
    if (axis === undefined) return;
    for (const value of axis.values) {
      current[axis.name] = value;
      walk(index + 1, current);
      if (combinations.length >= MAX_VARIANTS) return;
    }
  };
  walk(0, {});

  const total = expanded.reduce((count, axis) => count * axis.values.length, 1);

  return {
    variants: combinations.map((variables, index) => ({
      label: variantLabel(body, index + 1, variables),
      prompt: substitute(body, variables),
      variables,
    })),
    total,
    capped: total > combinations.length,
    skipped,
  };
}

/* ---- Template presets ---- */

export interface TemplatePreset {
  readonly id: string;
  readonly name: string;
  /** Why an operator would run it, shown on hover. */
  readonly summary: string;
  readonly template: string;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Templates to start from, so the editor is never a blank page.
 *
 * Each one is a whole prompt whose variables already carry values, so choosing it
 * produces a run that is ready to send rather than a snippet that still has to be
 * finished. They are here to be edited: the point is that the first version of a
 * comparison should not also be a decision about how to word it.
 *
 * The spread is deliberate — two axes (length, format) and three tasks
 * (translation, code, reasoning) — because the same model tends to look alike on
 * one kind of prompt and come apart on another.
 */
export const TEMPLATE_PRESETS: readonly TemplatePreset[] = [
  {
    id: 'summary-lengths',
    name: 'Summary, three lengths',
    summary: 'Compression: does the model stay faithful when it has to be brief?',
    template: [
      'Summarise the passage below in at most {{words}} words.',
      '',
      'Passage:',
      'A router is only as good as the accounts behind it. When one endpoint starts',
      'returning errors, the operator needs the next request to go somewhere else',
      'without the caller noticing, and without losing the conversation. That means',
      'every account carries a state, every request carries a retry budget, and the',
      'two are reconciled on each hop.',
      '',
      'Summary:',
    ].join('\n'),
    values: { words: '10, 30, 60' },
  },
  {
    id: 'formats',
    name: 'Same facts, three formats',
    summary: 'Instruction following: can the model hold a format without adding prose?',
    template: [
      'Extract the three decisions from the notes below and return them as {{format}}.',
      'Return nothing else.',
      '',
      'Notes:',
      '- The router ships before the studio.',
      '- Quota checks move to a background job.',
      '- The pool keeps its own retry budget.',
      '',
      'Output:',
    ].join('\n'),
    values: { format: 'a JSON array of strings, a Markdown table, a plain bullet list' },
  },
  {
    id: 'translation',
    name: 'One sentence, three languages',
    summary: 'Multilingual quality and script handling.',
    template: [
      'Translate the sentence below into {{language}}. Return only the translation.',
      '',
      "Sentence: The router keeps every account's state, and the next request goes",
      'to whichever one can answer.',
      '',
      'Translation:',
    ].join('\n'),
    values: { language: 'Indonesian, Japanese, Arabic' },
  },
  {
    id: 'code',
    name: 'Same function, three languages',
    summary: 'Code generation and language switching.',
    template: [
      'Write a {{language}} function that takes a list of integers and returns the',
      'largest one. Return only the function, with no example usage.',
      '',
      'Function:',
    ].join('\n'),
    values: { language: 'Python, TypeScript, Go' },
  },
  {
    id: 'reasoning',
    name: 'Answer with and without working',
    summary: 'Does the model show its reasoning when asked, and hide it when not?',
    template: [
      '{{style}} A train leaves at 14:05 and arrives at 16:50. The journey has two',
      'stops of 4 minutes each. How many minutes is it actually moving?',
      '',
      'Answer:',
    ].join('\n'),
    values: { style: 'Answer in one line.,Show your working step by step.' },
  },
];

/* ---- Targets ---- */

export function targetKey(target: BenchmarkTarget): string {
  return `${target.providerId}::${target.model}`;
}

/** `anthropic` for a default model, `openai · gpt-4o-mini` otherwise. */
export function targetLabel(target: BenchmarkTarget): string {
  return target.model === '' ? target.providerId : `${target.providerId} · ${target.model}`;
}

/* ---- Aggregation ---- */

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function collect(
  results: readonly BenchmarkResult[],
  pick: (result: BenchmarkResult) => number | null,
): readonly number[] {
  const values: number[] = [];
  for (const result of results) {
    const value = pick(result);
    if (value !== null) values.push(value);
  }
  return values;
}

export interface TargetAggregate {
  readonly target: BenchmarkTarget;
  readonly cells: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly meanQuality: number | null;
  readonly meanTps: number | null;
  /** Mean time to first token. Never combined with `meanLatencyMs`. */
  readonly meanTtftMs: number | null;
  /** Mean total latency, first token to last. Never combined with `meanTtftMs`. */
  readonly meanLatencyMs: number | null;
  readonly totalCostUsd: number;
}

/**
 * One row per declared target, not per target that answered.
 *
 * A target that produced nothing still appears, with no figures. It was asked
 * for, so hiding it would make a run look smaller than it was and make the gap
 * impossible to notice.
 */
export function aggregateByTarget(
  targets: readonly BenchmarkTarget[],
  results: readonly BenchmarkResult[],
): readonly TargetAggregate[] {
  return targets.map((target) => {
    const key = targetKey(target);
    const mine = results.filter((result) => targetKey(result) === key);
    return {
      target,
      cells: mine.length,
      succeeded: mine.filter((result) => result.status === 'succeeded').length,
      failed: mine.filter((result) => result.status === 'failed').length,
      meanQuality: mean(collect(mine, (result) => result.qualityScore)),
      meanTps: mean(collect(mine, (result) => result.tokensPerSecond)),
      meanTtftMs: mean(collect(mine, (result) => result.ttftMs)),
      meanLatencyMs: mean(collect(mine, (result) => result.latencyMs)),
      totalCostUsd: mine.reduce((sum, result) => sum + (result.costUsd ?? 0), 0),
    };
  });
}

export interface RunSummary {
  readonly cells: number;
  readonly expected: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly meanQuality: number | null;
  readonly meanTps: number | null;
  readonly meanTtftMs: number | null;
  readonly meanLatencyMs: number | null;
  readonly totalCostUsd: number;
}

export function summariseRun(run: BenchmarkRun): RunSummary {
  return {
    cells: run.results.length,
    expected: run.expectedResultCount,
    succeeded: run.results.filter((result) => result.status === 'succeeded').length,
    failed: run.results.filter((result) => result.status === 'failed').length,
    meanQuality: mean(collect(run.results, (result) => result.qualityScore)),
    meanTps: mean(collect(run.results, (result) => result.tokensPerSecond)),
    meanTtftMs: mean(collect(run.results, (result) => result.ttftMs)),
    meanLatencyMs: mean(collect(run.results, (result) => result.latencyMs)),
    totalCostUsd: run.results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0),
  };
}

/** `0..1` of the cells that have arrived, or `null` when none were expected. */
export function runProgress(run: BenchmarkRun): number | null {
  if (run.expectedResultCount === 0) return null;
  return Math.min(1, run.results.length / run.expectedResultCount);
}

/** Cell id to variant label, so a result row can name the variant it ran. */
export function variantLabels(run: BenchmarkRun): ReadonlyMap<string, string> {
  return new Map(run.variants.map((variant) => [variant.id, variant.label]));
}

/* ---- Export ---- */

const CSV_COLUMNS = [
  'variant',
  'provider',
  'model',
  'status',
  'ttft_ms',
  'latency_ms',
  'output_tokens',
  'tokens_per_second',
  'cost_usd',
  'quality_score',
  'error',
] as const;

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function numberCell(value: number | null): string {
  return value === null ? '' : String(value);
}

/**
 * The cells as CSV, one row each.
 *
 * The two durations get their own columns under their own names, because a
 * spreadsheet is exactly where they would otherwise be averaged together.
 */
export function runToCsv(run: BenchmarkRun): string {
  const labels = variantLabels(run);
  const rows = run.results.map((result) => [
    labels.get(result.variantId) ?? result.variantId,
    result.providerId,
    result.model,
    result.status,
    numberCell(result.ttftMs),
    numberCell(result.latencyMs),
    numberCell(result.outputTokens),
    numberCell(result.tokensPerSecond),
    numberCell(result.costUsd),
    numberCell(result.qualityScore),
    result.error ?? '',
  ]);

  return [CSV_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

export function runToJson(run: BenchmarkRun): string {
  return JSON.stringify(run, null, 2);
}

export function exportFilename(run: BenchmarkRun, extension: string): string {
  const slug = run.name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return `${slug === '' ? run.id : slug}.${extension}`;
}

/** What the editor holds before it becomes a `BenchmarkInput`. */
export interface RunDraft {
  readonly name: string;
  readonly template: string;
  readonly values: Readonly<Record<string, string>>;
  readonly systemPrompt: string;
  readonly targets: readonly BenchmarkTarget[];
  /** What each answer is scored against (FR-9.2). Empty means timing and cost only. */
  readonly rubric: readonly BenchmarkAssertion[];
}

export function emptyRunDraft(): RunDraft {
  return {
    name: '',
    template: '',
    values: {},
    systemPrompt: '',
    targets: [],
    rubric: [],
  };
}

export function toInput(draft: RunDraft, variants: readonly BenchmarkVariantInput[]): BenchmarkInput {
  return {
    name: draft.name.trim(),
    template: draft.template.trim(),
    variants: [...variants],
    targets: [...draft.targets],
    systemPrompt: draft.systemPrompt.trim() === '' ? null : draft.systemPrompt,
    // Blank rows are dropped rather than refused: a half-typed assertion is the
    // ordinary state of an editor, and the run should send what the operator
    // finished writing rather than complain about the line they were still on.
    rubric: draft.rubric.filter(isUsableAssertion),
  };
}

/**
 * Whether a rubric row is worth sending.
 *
 * A `contains` or a `regex` with no pattern would match everything, and a check
 * that always passes is worse than no check at all: it inflates every cell's
 * score without testing anything. A `max_length` of zero is the same fault the
 * other way round.
 */
function isUsableAssertion(assertion: BenchmarkAssertion): boolean {
  if (assertion.kind === 'max_length') return assertion.value > 0;
  return assertion.value.trim() !== '';
}

/** The three kinds, with the words an operator picks them by. */
export const ASSERTION_LABELS: Record<BenchmarkAssertion['kind'], string> = {
  contains: 'Contains',
  regex: 'Matches',
  max_length: 'At most N characters',
};

export const ASSERTION_KINDS = ['contains', 'regex', 'max_length'] as const;

export const ASSERTION_PLACEHOLDERS: Record<BenchmarkAssertion['kind'], string> = {
  contains: 'a phrase the answer must include',
  regex: 'a pattern the answer must match, e.g. ^\\s*\\{',
  max_length: '400',
};

/** A fresh row of the given kind, carrying nothing yet. */
export function emptyAssertion(kind: BenchmarkAssertion['kind']): BenchmarkAssertion {
  return kind === 'max_length' ? { kind, value: 0 } : { kind, value: '' };
}

/** How a rubric row reads in the run detail, where it is shown rather than edited. */
export function assertionLabel(assertion: BenchmarkAssertion): string {
  switch (assertion.kind) {
    case 'contains':
      return `contains “${assertion.value}”`;
    case 'regex':
      return `matches /${assertion.value}/`;
    case 'max_length':
      return `at most ${formatCount(assertion.value)} characters`;
  }
}
