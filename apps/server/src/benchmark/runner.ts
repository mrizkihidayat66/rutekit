import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchmarkInput, BenchmarkRun } from '@contracts';
import type { Logger } from 'pino';

import type { ApiKeyService } from '@server/api-keys/service.ts';
import { AppError } from '@server/errors.ts';
import type { BenchmarkRepository, BenchmarkRunRow } from '@server/persistence/benchmark.ts';

import { planRun } from './config.ts';
import type { BenchmarkEngine } from './engine.ts';
import { parseResults } from './results.ts';
import { toBenchmarkRun } from './catalog.ts';

/**
 * One benchmark run, from the operator's form to a matrix of cells (C11).
 *
 * The shape of it: mint a key, write the config, spawn promptfoo, read what it
 * produced, store the cells, revoke the key. Every one of those is somebody
 * else's job — the key service, the config generator, the engine, the parser —
 * and this file is only the order they run in, plus the one thing that is
 * genuinely its own: **the key's lifetime.**
 *
 * **The key is minted for the run and revoked at the end of it, on every path.**
 * A benchmark is a client of this instance like any other, so it authenticates
 * like one — but a key that outlived its run would be a credential sitting in a
 * key list with nothing left to use it. So `revoke` is in a `finally`, which
 * means a run that fails, times out or is interrupted still gives its key back.
 * The key is scoped to the run's models, so even during the run it reaches
 * nothing the run did not ask for.
 *
 * **The run's cells are written once, at the end.** promptfoo reports its whole
 * matrix in one file, so there is no progress to stream per cell: the console
 * sees a run go `queued → running → succeeded` and the table fills in when it
 * lands. That is honest about what the engine gives us, and it is why the run
 * carries an `expectedResultCount` — a page can show "0 of 120 cells" without
 * having any of them.
 *
 * **A run whose engine is missing fails at the run, not at the boot.** promptfoo
 * is a dependency, so it is normally there; a machine where it is not gets a
 * failed run whose error says what to install, rather than a server that will not
 * start over a feature nobody used yet.
 */

export interface BenchmarkRunner {
  /** Create a run and start it. Answers immediately with the queued run. */
  start(input: BenchmarkInput): BenchmarkRun;
  /** Mark rows left live by a previous process as failed. Returns how many. */
  recover(): number;
}

export interface BenchmarkRunnerDeps {
  readonly runs: BenchmarkRepository;
  readonly apiKeys: ApiKeyService;
  readonly engine: BenchmarkEngine | null;
  /** The instance's own origin, which the thin provider calls back into. */
  readonly baseUrl: string;
  /** Where per-run workspaces live: `<dataDir>/benchmark`. */
  readonly workspaceRoot: string;
  /** Absolute path to the provider script the workspace is given. */
  readonly providerSource: string;
  /** How many cells promptfoo may run at once. */
  readonly maxConcurrency: number;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** What the thin provider is copied to inside a run's workspace. */
const PROVIDER_FILE = 'provider.cjs';

export function createBenchmarkRunner(deps: BenchmarkRunnerDeps): BenchmarkRunner {
  const now = deps.now ?? ((): Date => new Date());
  const newId = deps.newId ?? ((): string => crypto.randomUUID());

  function move(id: string, patch: Parameters<BenchmarkRepository['updateRun']>[1]): BenchmarkRun {
    deps.runs.updateRun(id, patch);
    const row = deps.runs.findRun(id);
    if (row === null) throw AppError.internal(new Error(`benchmark run ${id} vanished mid-run`));
    return toBenchmarkRun(row, deps.runs.resultsOf(id));
  }

  async function execute(id: string, row: BenchmarkRunRow): Promise<void> {
    const workspace = join(deps.workspaceRoot, id);
    // The key is minted before anything else so that every exit below has one to
    // give back, and revoked in the `finally` — a run that throws still returns
    // its credential.
    let keyId: string | null = null;

    try {
      if (deps.engine === null) {
        throw AppError.unavailable(
          'promptfoo is not installed, so benchmarks cannot run. Install it and restart rutekit.',
        );
      }

      const created = deps.apiKeys.create({
        name: `benchmark: ${row.name}`.slice(0, 120),
        // Scoped to the models this run asked for, so the key is worth nothing
        // outside the run even while it is alive.
        modelsAllowed: [...new Set(row.targets.map((target) => target.model))],
        modelsDenied: [],
        budgetRequests: null,
        budgetTokens: null,
        tpsLimit: null,
        rateLimitPerMinute: null,
        // No expiry: the run's end is what retires this key, and an expiry that
        // fired mid-run would fail the last cells for no reason an operator
        // could see. The `finally` is what makes that safe.
        expiresAt: null,
        clientRouterDenylist: [],
      });
      keyId = created.apiKey.id;

      move(id, { status: 'running', startedAt: now().toISOString(), workspaceDir: workspace });

      const plan = planRun(row.variants, row.targets, {
        baseUrl: deps.baseUrl,
        providerFile: PROVIDER_FILE,
        systemPrompt: row.systemPrompt,
        rubric: row.rubric,
        // The run's own choice is not on the contract yet, so every benchmark
        // cell asks for the model's default. Stated rather than hidden: a
        // `thinkingLevel` on a benchmark would be a fair thing to add.
        thinkingLevel: 'auto',
      });

      const result = await deps.engine.run({
        workspace,
        document: plan.document,
        providerSource: deps.providerSource,
        providerFile: PROVIDER_FILE,
        apiKey: created.secret,
        maxConcurrency: deps.maxConcurrency,
      });

      const parsed = parseResults(result.output, plan);
      if (parsed.unmatched.length > 0) {
        deps.logger.warn(
          { runId: id, unmatched: parsed.unmatched.slice(0, 20) },
          'promptfoo reported rows this run did not plan',
        );
      }

      deps.runs.appendResults(parsed.cells.map((cell) => ({ ...cell, runId: id })));

      const failed = parsed.cells.filter((cell) => cell.status === 'failed').length;
      // A run whose every cell failed is a failed run, not a succeeded one with
      // a bad table: the difference matters to an operator scanning the list.
      const status = parsed.cells.length > 0 && failed === parsed.cells.length ? 'failed' : 'succeeded';

      move(id, {
        status,
        error:
          status === 'failed'
            ? 'Every cell failed; see the results for what each one reported.'
            : null,
        finishedAt: now().toISOString(),
      });
    } catch (error) {
      move(id, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'The run failed for no reason it reported.',
        finishedAt: now().toISOString(),
      });
      deps.logger.warn({ err: error, runId: id }, 'a benchmark run failed');
    } finally {
      if (keyId !== null) {
        try {
          deps.apiKeys.revoke(keyId);
        } catch (cause) {
          // The run is over either way; a key that could not be revoked is worth
          // a loud line rather than a failed run, because the operator has to
          // remove it by hand and needs to know.
          deps.logger.error(
            { err: cause, runId: id, keyId },
            'the benchmark key could not be revoked and is still active',
          );
        }
      }
    }
  }

  return {
    start(input: BenchmarkInput): BenchmarkRun {
      const id = newId();
      const at = now().toISOString();
      const variants = input.variants.map((variant) => ({
        id: newId(),
        label: variant.label,
        prompt: variant.prompt,
        variables: { ...variant.variables },
      }));

      const row = deps.runs.createRun({
        id,
        name: input.name,
        status: 'queued',
        template: input.template,
        variants,
        targets: [...input.targets],
        rubric: [...input.rubric],
        systemPrompt: input.systemPrompt,
        expectedResultCount: variants.length * input.targets.length,
        error: null,
        workspaceDir: null,
        createdAt: at,
        startedAt: null,
        finishedAt: null,
      });

      const run = toBenchmarkRun(row, []);

      // Started rather than awaited: the console's request answers with the
      // queued run and watches it, because a benchmark is minutes of work and a
      // request that waited for it would be a request that timed out.
      void mkdir(deps.workspaceRoot, { recursive: true })
        .then(() => execute(id, row))
        .catch((error: unknown) => {
          deps.logger.error({ err: error, runId: id }, 'a benchmark run could not be started');
        });

      return run;
    },

    recover(): number {
      const moved = deps.runs.interruptLive(
        'The server restarted while this run was going.',
        now().toISOString(),
      );
      return moved.length;
    },
  };
}

/**
 * Remove a run's workspace.
 *
 * Not called automatically: the workspace is what makes a run re-runnable by
 * hand, which is the portability ADR-0017 wanted from the YAML in the first
 * place. This exists for a sweep, and is exported so that sweep has one
 * implementation rather than its own `rm`.
 */
export async function clearWorkspace(workspaceRoot: string, runId: string): Promise<void> {
  await rm(join(workspaceRoot, runId), { recursive: true, force: true });
}
