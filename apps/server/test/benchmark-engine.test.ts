import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planRun } from '@server/benchmark/config.ts';
import {
  createPromptfooEngine,
  promptfooEntrypoint,
  resolvePromptfooPackage,
} from '@server/benchmark/engine.ts';
import { parseResults } from '@server/benchmark/results.ts';
import { silentLogger } from '@server/observability/logger.ts';

/**
 * The real engine, against a stand-in for rutekit's own `/v1` (C11).
 *
 * Everything else in this feature is tested through a seam, which is what makes
 * the seams worth having — but it also means nothing else would notice if the
 * thin provider and promptfoo disagreed about how a provider is called. This is
 * the one test that runs the whole chain for real: a config written to disk,
 * promptfoo spawned, the provider script loaded by promptfoo, an SSE stream read
 * and timed, `results.json` written, and the cells parsed back out.
 *
 * **It is skipped when promptfoo is not installed** rather than failing, because
 * the feature degrades to a run that says so — and a machine without it should
 * see that sentence, not a red test suite. Everything else about the benchmark
 * is asserted with a fake engine in `benchmark-routes.test.ts`.
 *
 * **The stand-in answers the way the real surface does**: an OpenAI SSE stream
 * with content deltas and a usage frame, plus a deliberate pause before the first
 * one so the first-token time is measurably later than the request. A server that
 * answered instantly would make `ttftMs` and `latencyMs` indistinguishable, and
 * the whole point of the thin provider is that they are not.
 */

/** How long the stand-in waits before its first frame. */
const FIRST_TOKEN_DELAY_MS = 60;

interface StandIn {
  readonly baseUrl: string;
  readonly calls: { readonly model: string; readonly authorization: string; readonly messages: number }[];
  stop(): void;
}

function startStandIn(): StandIn {
  const calls: StandIn['calls'] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const body = (await request.json()) as {
        model: string;
        messages: { role: string; content: string }[];
      };
      calls.push({
        model: body.model,
        authorization: request.headers.get('authorization') ?? '',
        messages: body.messages.length,
      });

      const text = `answer for ${body.model}: ${body.messages.at(-1)?.content?.slice(0, 16) ?? ''}`;
      const frames = [
        {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        },
        {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        },
      ];

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          await new Promise((resolve) => setTimeout(resolve, FIRST_TOKEN_DELAY_MS));
          for (const frame of frames) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${String(server.port)}`,
    calls,
    stop: () => {
      // `stop` returns a promise; the suite is finishing either way, and awaiting
      // it in `afterAll` would be waiting on a socket that is already closing.
      void server.stop(true);
    },
  };
}

const entrypoint = promptfooEntrypoint(resolvePromptfooPackage);

/**
 * The repository root, computed from this file rather than from `process.cwd()`.
 *
 * The test runner's working directory is not something a test should depend on,
 * and a relative path that happens to be right today is a path that breaks the
 * first time the suite is run from somewhere else.
 */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PROVIDER_SOURCE = join(REPO_ROOT, 'tools', 'benchmark-provider', 'provider.cjs');

describe.skipIf(entrypoint === null)('the promptfoo engine, for real', () => {
  let stand: StandIn;

  beforeAll(() => {
    stand = startStandIn();
  });

  afterAll(() => {
    stand.stop();
  });

  it('runs the matrix, times the first token, and reads the cells back', async () => {
    if (entrypoint === null) throw new Error('unreachable: the suite is skipped without it');

    const plan = planRun(
      [
        { id: 'var_a', label: 'A', prompt: 'Summarise alpha.', variables: {} },
        { id: 'var_b', label: 'B', prompt: 'Summarise beta.', variables: {} },
      ],
      [
        { providerId: 'openai', model: 'gpt-4o-mini' },
        { providerId: 'anthropic', model: 'claude-3-opus-20240229' },
      ],
      {
        baseUrl: stand.baseUrl,
        providerFile: 'provider.cjs',
        systemPrompt: 'Be brief.',
        // Two checks so the score is a fraction rather than a boolean, which is
        // what the contract promises and what the page renders.
        rubric: [
          { kind: 'contains', value: 'answer' },
          { kind: 'max_length', value: 200 },
        ],
        thinkingLevel: 'auto',
      },
    );

    const engine = createPromptfooEngine({
      logger: silentLogger(),
      nodeBinary: 'node',
      entrypoint,
      timeoutMs: 240_000,
    });

    const workspace = mkdtempSync(join(tmpdir(), 'rutekit-benchmark-'));
    const result = await engine.run({
      workspace,
      document: plan.document,
      providerSource: PROVIDER_SOURCE,
      providerFile: 'provider.cjs',
      apiKey: 'sk-benchmark-integration',
      maxConcurrency: 2,
    });

    // 0 for a clean run; 100 is promptfoo's "some assertions failed", which is
    // the ordinary outcome of a benchmark whose point is that models differ.
    expect([0, 100]).toContain(result.exitCode);

    const parsed = parseResults(result.output, plan);
    expect(parsed.unmatched).toEqual([]);
    expect(parsed.cells).toHaveLength(4);
    expect(parsed.cells.every((cell) => cell.status === 'succeeded')).toBe(true);

    // Every cell reached the stand-in with the run's key and both messages — the
    // system prompt is one of them, which is how it reaches every variant.
    expect(stand.calls).toHaveLength(4);
    expect(stand.calls.every((call) => call.authorization === 'Bearer sk-benchmark-integration')).toBe(true);
    expect(stand.calls.every((call) => call.messages === 2)).toBe(true);
    expect(new Set(stand.calls.map((call) => call.model))).toEqual(
      new Set(['gpt-4o-mini', 'claude-3-opus-20240229']),
    );

    for (const cell of parsed.cells) {
      // The first token was timed, and it is measurably later than the request
      // because the stand-in waits before it says anything. This is the figure
      // promptfoo has no column for, which is why the thin provider exists.
      expect(cell.ttftMs).not.toBeNull();
      expect(cell.ttftMs ?? 0).toBeGreaterThanOrEqual(FIRST_TOKEN_DELAY_MS - 15);
      // And the total is a separate figure rather than the same one.
      expect(cell.latencyMs).not.toBeNull();
      expect(cell.outputTokens).toBe(5);
      // Both assertions passed, so the cell scored the whole rubric.
      expect(cell.qualityScore).toBe(1);
      expect(cell.outputPreview).toContain('answer for');
      expect(cell.error).toBeNull();
    }

    // Variant-major, which is the order the table renders in.
    expect(parsed.cells.map((cell) => cell.position)).toEqual([0, 1, 2, 3]);
    expect(parsed.cells[0]?.variantId).toBe('var_a');
    expect(parsed.cells[0]?.providerId).toBe('openai');
    expect(parsed.cells[3]?.variantId).toBe('var_b');
    expect(parsed.cells[3]?.providerId).toBe('anthropic');
  }, 300_000);

  it('reports a failing rubric as a fraction rather than as a pass or a fail', async () => {
    if (entrypoint === null) throw new Error('unreachable: the suite is skipped without it');

    const plan = planRun(
      [{ id: 'v', label: 'v', prompt: 'Summarise alpha.', variables: {} }],
      [{ providerId: 'openai', model: 'gpt-4o-mini' }],
      {
        baseUrl: stand.baseUrl,
        providerFile: 'provider.cjs',
        systemPrompt: null,
        // One of these cannot pass against the stand-in's answer, so the cell
        // scores a half rather than zero or one.
        rubric: [
          { kind: 'contains', value: 'answer' },
          { kind: 'contains', value: 'something the answer never says' },
        ],
        thinkingLevel: 'auto',
      },
    );

    const engine = createPromptfooEngine({
      logger: silentLogger(),
      nodeBinary: 'node',
      entrypoint,
      timeoutMs: 240_000,
    });

    const result = await engine.run({
      workspace: mkdtempSync(join(tmpdir(), 'rutekit-benchmark-')),
      document: plan.document,
      providerSource: PROVIDER_SOURCE,
      providerFile: 'provider.cjs',
      apiKey: 'sk-benchmark-integration',
      maxConcurrency: 1,
    });

    const parsed = parseResults(result.output, plan);
    expect(parsed.cells[0]?.qualityScore).toBe(0.5);
    // A cell that scored below the whole rubric still succeeded: the model
    // answered, and the score is a statement about the answer rather than about
    // the request.
    expect(parsed.cells[0]?.status).toBe('succeeded');
  }, 300_000);

  it('records a refused call as a failed cell carrying the refusal', async () => {
    if (entrypoint === null) throw new Error('unreachable: the suite is skipped without it');

    // A base URL nothing is listening on: the thin provider cannot reach rutekit
    // at all, which is the shape of a benchmark run against a stopped server.
    const plan = planRun(
      [{ id: 'v', label: 'v', prompt: 'Summarise alpha.', variables: {} }],
      [{ providerId: 'openai', model: 'gpt-4o-mini' }],
      {
        baseUrl: 'http://127.0.0.1:1',
        providerFile: 'provider.cjs',
        systemPrompt: null,
        rubric: [],
        thinkingLevel: 'auto',
      },
    );

    const engine = createPromptfooEngine({
      logger: silentLogger(),
      nodeBinary: 'node',
      entrypoint,
      timeoutMs: 240_000,
    });

    const result = await engine.run({
      workspace: mkdtempSync(join(tmpdir(), 'rutekit-benchmark-')),
      document: plan.document,
      providerSource: PROVIDER_SOURCE,
      providerFile: 'provider.cjs',
      apiKey: 'sk-benchmark-integration',
      maxConcurrency: 1,
    });

    const parsed = parseResults(result.output, plan);
    const cell = parsed.cells[0];
    expect(cell?.status).toBe('failed');
    expect(cell?.error).toMatch(/could not reach rutekit/);
    expect(cell?.qualityScore).toBeNull();
  }, 300_000);
});
