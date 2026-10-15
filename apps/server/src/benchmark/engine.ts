import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';

import { AppError } from '@server/errors.ts';

/**
 * Running promptfoo, behind a seam (C11, ADR-0017).
 *
 * The engine is a child process — promptfoo is a CLI, not a library rutekit
 * embeds — so this is the seam between the two, in the same shape the automation
 * worker uses. It is an interface rather than a function because everything
 * interesting about a run happens around the call: what the config said, what the
 * results parsed to, and what a non-zero exit means. A test drives all of that
 * through a fake engine and never spawns anything.
 *
 * **Exit code 100 is success.** promptfoo answers 100 when the evaluation
 * finished and some assertions failed, which is the ordinary outcome of a
 * benchmark whose point is that models differ. Treating it as an error would
 * report every run that found something as broken. Everything else non-zero is a
 * real failure and its stderr is the reason.
 *
 * **The child gets no key on its command line.** The API key the run minted
 * arrives in the environment, so it never appears in a process listing, in the
 * config file, or in a log line — and the config file outlives the run, because
 * the workspace is kept so an operator can re-run the YAML by hand.
 *
 * **Every path handed to the child is absolute, and on Windows that is not a
 * preference.** Given a relative `--output results.json`, promptfoo calls
 * `mkdir(dirname(path))` — that is, `mkdir('.')` — which fails with `EEXIST` on
 * Windows and takes the whole run down with "one or more output writes failed".
 * An absolute path has a real directory for its dirname, so the same code is
 * correct on both platforms.
 */

export interface EngineRequest {
  /** The directory the run owns: the config, the provider script, the output. */
  readonly workspace: string;
  /** The config document. Written as `promptfooconfig.yaml`. */
  readonly document: Record<string, unknown>;
  /** Where the provider script is copied from. */
  readonly providerSource: string;
  /** The filename it is copied to, relative to the workspace. */
  readonly providerFile: string;
  /** The run's key, in the child's environment only. */
  readonly apiKey: string;
  /** How many cells promptfoo may run at once. */
  readonly maxConcurrency: number;
}

export interface EngineResult {
  /** The parsed `results.json`, or null when none was written. */
  readonly output: unknown;
  readonly exitCode: number | null;
  readonly stderr: string;
}

export interface BenchmarkEngine {
  run(request: EngineRequest): Promise<EngineResult>;
}

export interface PromptfooEngineDeps {
  readonly logger: Logger;
  /** The runtime that runs the CLI. Node, not Bun. */
  readonly nodeBinary: string;
  /** Absolute path to promptfoo's CLI entrypoint. */
  readonly entrypoint: string;
  /** How long one run may take. */
  readonly timeoutMs: number;
}

/** promptfoo's "the evaluation finished, some assertions failed". */
const EXIT_ASSERTIONS_FAILED = 100;

export function createPromptfooEngine(deps: PromptfooEngineDeps): BenchmarkEngine {
  return {
    async run(request: EngineRequest): Promise<EngineResult> {
      const configPath = join(request.workspace, 'promptfooconfig.yaml');
      const outputPath = join(request.workspace, 'results.json');

      await mkdir(request.workspace, { recursive: true });
      await writeFile(
        configPath,
        // JSON, which is YAML — see `config.ts` for why that is a correctness
        // property rather than a shortcut.
        `${JSON.stringify(request.document, null, 2)}\n`,
        'utf8',
      );
      await copyFile(request.providerSource, join(request.workspace, request.providerFile));

      // Collected across the child's lifetime and read by `readOutput` below, so
      // it lives out here rather than inside the promise's executor.
      let stderr = '';

      /**
       * The file promptfoo wrote, or an honest account of why there is none.
       *
       * A clean exit with no output is promptfoo having decided there was nothing
       * to run — an empty matrix, or a config it silently refused. The caller
       * records that as a run with no cells rather than as a crash, because the
       * process did not crash.
       */
      async function readOutput(): Promise<EngineResult> {
        let raw: string;
        try {
          raw = await readFile(outputPath, 'utf8');
        } catch {
          return { output: null, exitCode: EXIT_ASSERTIONS_FAILED, stderr };
        }
        try {
          return { output: JSON.parse(raw) as unknown, exitCode: 0, stderr };
        } catch (cause) {
          throw AppError.internal(
            new Error(`promptfoo wrote output that is not JSON: ${String(cause)}`),
          );
        }
      }

      return new Promise<EngineResult>((resolve, reject) => {
        const child = spawn(
          deps.nodeBinary,
          [
            deps.entrypoint,
            'eval',
            '-c',
            configPath,
            '--output',
            outputPath,
            '--no-progress-bar',
            '--no-table',
            '--max-concurrency',
            String(request.maxConcurrency),
          ],
          {
            // The workspace is the working directory, so every path promptfoo
            // writes is relative to the run that owns it and a `.promptfoo`
            // cache lands there rather than in the operator's home directory.
            cwd: request.workspace,
            env: {
              ...process.env,
              RUTEKIT_BENCHMARK_KEY: request.apiKey,
              PROMPTFOO_CACHE_PATH: join(request.workspace, '.promptfoo-cache'),
              PROMPTFOO_CONFIG_DIR: join(request.workspace, '.promptfoo'),
              // The console is not watching a terminal, and a CLI that decides to
              // open a browser is a process that never exits.
              PROMPTFOO_DISABLE_TELEMETRY: '1',
              PROMPTFOO_DISABLE_UPDATE: '1',
              PROMPTFOO_DISABLE_SHARE: '1',
            },
          },
        );

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          // Bounded: a run that fails in a loop can produce a great deal of
          // output, and the message an operator reads is the first part of it.
          if (stderr.length < STDERR_LIMIT) stderr += chunk;
        });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(
            AppError.timeout(
              `The benchmark ran out of time after ${String(deps.timeoutMs)} ms.`,
            ),
          );
        }, deps.timeoutMs);
        timer.unref?.();

        child.on('error', (cause) => {
          clearTimeout(timer);
          reject(
            AppError.internal(
              new Error(`promptfoo could not be started: ${String(cause.message)}`),
            ),
          );
        });

        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code !== 0 && code !== EXIT_ASSERTIONS_FAILED) {
            deps.logger.warn({ code, stderr: stderr.slice(0, 2_000) }, 'promptfoo failed');
            reject(
              AppError.internal(
                new Error(`promptfoo exited with ${String(code)}: ${firstLine(stderr)}`),
              ),
            );
            return;
          }
          void readOutput().then(resolve, reject);
        });
      });
    },
  };
}

/** A stderr blob's first non-empty line: the part that names the failure. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return 'no reason given';
}

const STDERR_LIMIT = 64 * 1024;

/**
 * Where promptfoo's package manifest is, resolved from this file.
 *
 * `createRequire` rather than `import.meta.resolve`, and the difference is not
 * cosmetic: `import.meta.resolve` does not exist under the test runner, which
 * replaces `import.meta` with its own object — so a resolution built on it works
 * in production and silently fails in every test, and a test that silently skips
 * is worse than no test at all. `createRequire` is the standard Node API and
 * behaves the same under both.
 */
export function resolvePromptfooPackage(): string {
  return createRequire(import.meta.url).resolve('promptfoo/package.json');
}

/**
 * Where promptfoo's CLI lives, given a resolver for its package manifest.
 *
 * Kept separate from the engine so the resolution — the one part that depends on
 * the runtime's module layout — can be tested on its own. It answers null rather
 * than throwing when the package is absent, so a machine without it gets a
 * sentence about installing it rather than a boot that fails.
 *
 * **A resolver may answer with a URL, and `spawn` needs a path.** Handing
 * `file:///D:/…/package.json` to `spawn` as an argument is a file that does not
 * exist, so it is converted here — which is also what makes this correct on
 * Windows rather than only on a POSIX host.
 */
export function promptfooEntrypoint(resolvePackageJson: () => string): string | null {
  let resolved: string;
  try {
    resolved = resolvePackageJson();
  } catch {
    return null;
  }
  const packageJson = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;
  // `<pkg>/package.json` → `<pkg>/dist/src/entrypoint.js`, which is what the
  // package's own `bin` points at.
  const root = packageJson.replace(/package\.json$/u, '');
  return `${root}dist/src/entrypoint.js`;
}
