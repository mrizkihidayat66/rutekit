import { describe, expect, it } from 'vitest';
import type { BenchmarkAssertion, BenchmarkTarget, BenchmarkVariant } from '@contracts';

import { assertionFor, planRun, targetKey } from '@server/benchmark/config.ts';
import { promptfooEntrypoint } from '@server/benchmark/engine.ts';
import { parseResults, rowsOf } from '@server/benchmark/results.ts';

/**
 * The Benchmark's pure parts (C11).
 *
 * Three functions that sit between two systems with no shared vocabulary: the
 * contract on one side, promptfoo on the other. A mistake in any of them is
 * invisible in a route test — a rubric that maps to the wrong assertion still
 * produces a number, and a cell mapped to the wrong variant still produces a
 * row — so each is asserted on its own terms here.
 */

const VARIANTS: readonly BenchmarkVariant[] = [
  { id: 'var_1', label: 'Legal, 40 words', prompt: 'Summarise the contract in 40 words.', variables: {} },
  { id: 'var_2', label: 'Executive, 25 words', prompt: 'Summarise the report in 25 words.', variables: {} },
];

const TARGETS: readonly BenchmarkTarget[] = [
  { providerId: 'openai', model: 'gpt-4o-mini' },
  { providerId: 'anthropic', model: 'claude-3-opus-20240229' },
];

function plan(rubric: readonly BenchmarkAssertion[] = []) {
  return planRun(VARIANTS, TARGETS, {
    baseUrl: 'http://127.0.0.1:7331',
    providerFile: 'provider.cjs',
    systemPrompt: 'Be brief.',
    rubric,
    thinkingLevel: 'auto',
  });
}

/* ---- The rubric ---- */

describe('the rubric, as promptfoo assertions', () => {
  it('maps a contains to a contains', () => {
    expect(assertionFor({ kind: 'contains', value: 'lighthouse' })).toEqual({
      type: 'contains',
      value: 'lighthouse',
    });
  });

  it('maps a regex to a regex', () => {
    // promptfoo's `regex` is a search rather than a full match, which is what
    // the contract promises: "a pattern the answer must match somewhere".
    expect(assertionFor({ kind: 'regex', value: '^\\s*\\{' })).toEqual({
      type: 'regex',
      value: '^\\s*\\{',
    });
  });

  it('maps a max_length to a length check that includes the limit', () => {
    // `<=` rather than `<`: the contract says "longest acceptable answer", and a
    // limit of 400 refusing an answer of exactly 400 would be off by one in the
    // direction nobody expects.
    expect(assertionFor({ kind: 'max_length', value: 400 })).toEqual({
      type: 'javascript',
      value: 'output.length <= 400',
    });
  });
});

/* ---- The config document ---- */

describe('the promptfoo config', () => {
  it('makes one prompt per variant, labelled with the variant id', () => {
    // The label is the id, not the text: a cell is traced back to its variant by
    // reading this, and a label built from the prompt would be ambiguous the
    // first time two variants differed by a word.
    const { document } = plan();
    expect(document['prompts']).toEqual([
      { label: 'var_1', raw: 'Summarise the contract in 40 words.' },
      { label: 'var_2', raw: 'Summarise the report in 25 words.' },
    ]);
  });

  it('makes one provider per target, labelled with the target key', () => {
    const { document } = plan();
    expect(document['providers']).toEqual([
      {
        id: 'file://provider.cjs',
        label: 'openai::gpt-4o-mini',
        config: {
          baseUrl: 'http://127.0.0.1:7331',
          providerId: 'openai',
          model: 'gpt-4o-mini',
          systemPrompt: 'Be brief.',
          thinkingLevel: 'auto',
        },
      },
      {
        id: 'file://provider.cjs',
        label: 'anthropic::claude-3-opus-20240229',
        config: {
          baseUrl: 'http://127.0.0.1:7331',
          providerId: 'anthropic',
          model: 'claude-3-opus-20240229',
          systemPrompt: 'Be brief.',
          thinkingLevel: 'auto',
        },
      },
    ]);
  });

  it('carries the rubric as the test’s assertions', () => {
    const { document } = plan([{ kind: 'contains', value: 'x' }]);
    expect(document['tests']).toEqual([{ assert: [{ type: 'contains', value: 'x' }] }]);
  });

  it('sends no assertions for an empty rubric', () => {
    // An unscored run is legitimate, and promptfoo with an empty assert list
    // grades nothing — which is what leaves `qualityScore` null rather than 1.
    const { document } = plan();
    expect(document['tests']).toEqual([{ assert: [] }]);
  });

  it('does not substitute anything inside a variant prompt', () => {
    // `raw` rather than a template: a prompt a model is legitimately asked about
    // `{{…}}` must reach it intact, and running it back through promptfoo's own
    // substitution would silently rewrite it.
    const { document } = planRun(
      [{ id: 'v', label: 'v', prompt: 'What does {{this}} mean in Jinja?', variables: {} }],
      TARGETS,
      {
        baseUrl: 'http://127.0.0.1:7331',
        providerFile: 'provider.cjs',
        systemPrompt: null,
        rubric: [],
        thinkingLevel: 'auto',
      },
    );
    expect((document['prompts'] as { raw: string }[])[0]?.raw).toBe(
      'What does {{this}} mean in Jinja?',
    );
  });

  it('plans every cell of the matrix, variant-major', () => {
    const { cells } = plan();
    expect(cells.map((cell) => `${cell.variantId}|${targetKey(cell.target)}`)).toEqual([
      'var_1|openai::gpt-4o-mini',
      'var_1|anthropic::claude-3-opus-20240229',
      'var_2|openai::gpt-4o-mini',
      'var_2|anthropic::claude-3-opus-20240229',
    ]);
    // Position is the cell's place in the matrix, which is what the stored rows
    // are ordered by.
    expect(cells.map((cell) => cell.position)).toEqual([0, 1, 2, 3]);
  });

  it('is JSON-serialisable for any prompt, including one full of YAML punctuation', () => {
    // The document is written as JSON because YAML is a superset of it: a prompt
    // containing `- `, `#`, `:` or a leading newline is a valid YAML *document*
    // but would be a different document if it were interpolated into YAML text.
    const hostile = '---\nkey: value\n# comment\n- item\n: colon\n  indented';
    const { document } = planRun(
      [{ id: 'v', label: 'v', prompt: hostile, variables: {} }],
      TARGETS,
      {
        baseUrl: 'http://127.0.0.1:7331',
        providerFile: 'provider.cjs',
        systemPrompt: null,
        rubric: [],
        thinkingLevel: 'auto',
      },
    );
    const round = JSON.parse(JSON.stringify(document)) as { prompts: { raw: string }[] };
    expect(round.prompts[0]?.raw).toBe(hostile);
  });
});

/* ---- Reading promptfoo's output ---- */

/** A `results.json` as promptfoo writes it, with the parts this reads. */
function document(rows: readonly unknown[]): unknown {
  return { evalId: 'eval-1', results: { version: 3, results: rows } };
}

function row(options: {
  variant?: string;
  target?: string;
  output?: string;
  success?: boolean;
  error?: string;
  score?: number;
  ttftMs?: number;
  latencyMs?: number;
  completion?: number;
  tps?: number;
  cost?: number;
}): unknown {
  return {
    prompt: { label: options.variant ?? 'var_1' },
    provider: { label: options.target ?? 'openai::gpt-4o-mini' },
    success: options.success ?? true,
    error: options.error,
    gradingResult: options.score === undefined ? {} : { score: options.score },
    response: {
      output: options.output ?? 'a summary',
      latencyMs: options.latencyMs ?? 900,
      cost: options.cost ?? 0.0004,
      metadata: { ttftMs: options.ttftMs ?? 210, outputTokens: options.completion ?? 42, tokensPerSecond: options.tps ?? 55 },
      tokenUsage: { completion: options.completion ?? 42 },
      // promptfoo sets the error on the response only when the request could not
      // be made, which is the one signal that means "this cell failed".
      ...(options.error === undefined ? {} : { error: options.error }),
    },
  };
}

describe('reading results.json', () => {
  it('reads nothing from a document that is not one', () => {
    // A shape this cannot read yields no rows rather than a throw: the caller
    // records the run as failed with a reason, which beats a run that fails
    // while trying to describe why it failed.
    expect(rowsOf(null)).toEqual([]);
    expect(rowsOf({})).toEqual([]);
    expect(rowsOf({ results: { results: 'nope' } })).toEqual([]);
  });

  it('reads the two durations as two separate figures', () => {
    // The whole reason the thin provider exists (ADR-0017): promptfoo measures a
    // request, and the time to the first token is not a number it has a column
    // for. They are never combined.
    const { cells } = parseResults(
      document([row({ ttftMs: 210, latencyMs: 900 })]),
      plan(),
    );
    const cell = cells.find((entry) => entry.position === 0);
    expect(cell?.ttftMs).toBe(210);
    expect(cell?.latencyMs).toBe(900);
  });

  it('leaves the first-token time null when the provider reported none', () => {
    // Null rather than derived from the latency: a figure nobody measured is
    // worse than a figure that is absent.
    const raw = row({});
    (raw as { response: { metadata: Record<string, unknown> } }).response.metadata = {};
    const { cells } = parseResults(document([raw]), plan());
    expect(cells.find((entry) => entry.position === 0)?.ttftMs).toBeNull();
  });

  it('reads the score as the fraction promptfoo graded', () => {
    const { cells } = parseResults(document([row({ score: 0.67 })]), plan());
    expect(cells.find((entry) => entry.position === 0)?.qualityScore).toBe(0.67);
  });

  it('leaves the score null for a run with no rubric', () => {
    // promptfoo grades nothing without assertions, so `gradingResult` is empty
    // and there is no score — the contract's own "the run had no rubric".
    const { cells } = parseResults(document([row({})]), plan());
    expect(cells.find((entry) => entry.position === 0)?.qualityScore).toBeNull();
  });

  it('reads a failed call with its reason and no score', () => {
    const { cells } = parseResults(
      document([row({ success: false, error: 'rutekit answered 429: quota', score: 0 })]),
      plan(),
    );
    const cell = cells.find((entry) => entry.position === 0);
    expect(cell?.status).toBe('failed');
    expect(cell?.error).toContain('quota');
    // A cell whose call failed was not scored, whatever promptfoo's grading says
    // about the empty output it graded.
    expect(cell?.qualityScore).toBeNull();
  });

  it('keeps the score of a cell whose assertions did not all pass', () => {
    // promptfoo answers a failing assertion with `success: false` *and* by
    // putting the assertion's reason in the row's `error` — so reading either as
    // a failed cell would throw away the score of every model that answered well
    // without answering perfectly, which is every model a benchmark exists to
    // compare. The answer here is real; only the rubric was unhappy with it.
    const { cells } = parseResults(
      document([
        row({ success: false, score: 0.5, output: 'a partial answer' }),
      ]),
      plan(),
    );
    const cell = cells.find((entry) => entry.position === 0);
    expect(cell?.status).toBe('succeeded');
    expect(cell?.qualityScore).toBe(0.5);
    expect(cell?.error).toBeNull();
  });

  it('reads a row with no response at all as a failure', () => {
    // A cell promptfoo never got to attempt is a failure by the same reading.
    const { cells } = parseResults(document([{ prompt: { label: 'var_1' }, provider: { label: 'openai::gpt-4o-mini' }, error: 'the provider could not be loaded' }]), plan());
    const cell = cells.find((entry) => entry.position === 0);
    expect(cell?.status).toBe('failed');
    expect(cell?.error).toContain('could not be loaded');
  });

  it('keeps whatever arrived before a cell failed', () => {
    // A model that answered and then dropped the connection did start answering,
    // and that is the difference between "slow" and "unreachable".
    const { cells } = parseResults(
      document([row({ success: false, error: 'stream died', ttftMs: 180 })]),
      plan(),
    );
    expect(cells.find((entry) => entry.position === 0)?.ttftMs).toBe(180);
  });

  it('traces a row back to its variant and its target', () => {
    const { cells } = parseResults(
      document([row({ variant: 'var_2', target: 'anthropic::claude-3-opus-20240229' })]),
      plan(),
    );
    // Variant-major: `var_2` is the second variant, and `anthropic` the second
    // target, so its cell is the fourth.
    const cell = cells.find((entry) => entry.position === 3);
    expect(cell?.variantId).toBe('var_2');
    expect(cell?.providerId).toBe('anthropic');
    expect(cell?.model).toBe('claude-3-opus-20240229');
    expect(cell?.status).toBe('succeeded');
  });

  it('writes a failed row for a planned cell promptfoo never reported', () => {
    // A run killed part-way is a real outcome, and a table showing fewer cells
    // than were asked for is a table that lies about the run's size.
    const { cells } = parseResults(document([row({})]), plan());
    expect(cells).toHaveLength(4);
    expect(cells.filter((cell) => cell.status === 'failed')).toHaveLength(3);
    expect(cells.find((entry) => entry.position === 1)?.error).toMatch(/no result for this cell/);
  });

  it('refuses a row that names a pair this run never planned', () => {
    // Counting it would put a cell in the table that no variant or target
    // explains.
    const { cells, unmatched } = parseResults(
      document([row({ target: 'groq::llama-3.3-70b-versatile' })]),
      plan(),
    );
    expect(unmatched.some((line) => line.includes('groq::llama-3.3-70b-versatile'))).toBe(true);
    expect(cells.every((cell) => cell.providerId !== 'groq')).toBe(true);
  });

  it('refuses a row with no labels at all', () => {
    const { unmatched } = parseResults(document([{ response: { output: 'x' } }]), plan());
    expect(unmatched.some((line) => line.includes('no prompt or provider label'))).toBe(true);
  });

  it('drops a second row for a cell rather than writing over the first', () => {
    // The matrix has one answer per cell, and which of two rows was "right" is
    // not something this can know.
    const { cells, unmatched } = parseResults(
      document([row({ output: 'first' }), row({ output: 'second' })]),
      plan(),
    );
    expect(unmatched.some((line) => line.includes('appeared twice'))).toBe(true);
    expect(cells.filter((cell) => cell.position === 0)).toHaveLength(1);
    expect(cells.find((cell) => cell.position === 0)?.outputPreview).toBe('first');
  });

  it('clips the preview to one line', () => {
    const { cells } = parseResults(
      document([row({ output: 'line one\n\n   line two\t\tend' })]),
      plan(),
    );
    expect(cells.find((cell) => cell.position === 0)?.outputPreview).toBe('line one line two end');
  });

  it('orders the cells by their place in the matrix', () => {
    const { cells } = parseResults(
      document([
        row({ variant: 'var_2', target: 'anthropic::claude-3-opus-20240229' }),
        row({ variant: 'var_1', target: 'openai::gpt-4o-mini' }),
      ]),
      plan(),
    );
    expect(cells.map((cell) => cell.position)).toEqual([0, 1, 2, 3]);
  });
});

/* ---- Finding promptfoo ---- */

describe('locating promptfoo', () => {
  it('derives the CLI entrypoint from the package root', () => {
    expect(promptfooEntrypoint(() => '/pkgs/promptfoo/package.json')).toBe(
      '/pkgs/promptfoo/dist/src/entrypoint.js',
    );
  });

  it('answers null rather than throwing when it is not installed', () => {
    // A machine without it gets a sentence about installing it, not a boot that
    // fails over a feature nobody had used yet.
    expect(
      promptfooEntrypoint(() => {
        throw new Error('module not found');
      }),
    ).toBeNull();
  });
});
