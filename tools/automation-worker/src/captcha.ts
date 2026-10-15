/**
 * Solving a captcha automatically, when there is a solver (C7c, FR-5.3).
 *
 * Optional on purpose. The manual hand-off is what FR-5.4 and FR-5.5 specify, and
 * it works with no third party at all; a solver is an optimisation for operators
 * who have a Capsolver account and would rather not be interrupted. So this is a
 * seam with a null implementation, and the null implementation is the default:
 * with `RUTEKIT_CAPSOLVER_KEY` unset, every challenge goes to a human, which is
 * the behaviour an operator with no account should get.
 *
 * **The image leaves the machine.** Solving means posting the challenge to a
 * third party, which is why it is opt-in rather than automatic — an operator who
 * has not configured a key has not agreed to send anything anywhere.
 *
 * **Failure is null, never a throw.** A solver that is down, out of credit, or
 * wrong is a solver that did not help; the item then parks for a human exactly as
 * it would have without one. Throwing here would turn "the captcha service is
 * having a bad day" into "the batch failed".
 */

export interface CaptchaSolver {
  /** For the log line that says whether one is configured. */
  readonly name: string;
  /** The text, or null when this solver could not read it. */
  solve(imageDataUrl: string): Promise<string | null>;
}

/** No solver: every challenge goes to a human. */
export const noCaptchaSolver: CaptchaSolver = {
  name: 'none',
  solve: () => Promise.resolve(null),
};

export interface CapsolverOptions {
  readonly apiKey: string;
  /** Injectable so a test needs no network. */
  readonly fetch?: typeof globalThis.fetch;
  /** How long to wait for the answer before giving up on it. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Capsolver's own poll interval guidance for an image task. */
const POLL_INTERVAL_MS = 1_000;

export function createCapsolver(options: CapsolverOptions): CaptchaSolver {
  const call = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: 'capsolver',

    async solve(imageDataUrl: string): Promise<string | null> {
      // The data URL prefix is not part of the image, and Capsolver rejects it.
      const body = imageDataUrl.replace(/^data:image\/\w+;base64,/u, '');
      if (body === '') return null;

      const deadline = Date.now() + timeoutMs;
      try {
        const created = await call('https://api.capsolver.com/createTask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientKey: options.apiKey,
            task: { type: 'ImageToTextTask', body },
          }),
        });
        const task = (await created.json()) as { taskId?: unknown; errorId?: unknown };
        if (typeof task.taskId !== 'string') return null;

        for (;;) {
          if (Date.now() > deadline) return null;
          await sleep(POLL_INTERVAL_MS);

          const polled = await call('https://api.capsolver.com/getTaskResult', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientKey: options.apiKey, taskId: task.taskId }),
          });
          const result = (await polled.json()) as {
            status?: unknown;
            solution?: { text?: unknown };
          };
          if (result.status === 'ready') {
            const text = result.solution?.text;
            return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
          }
          if (result.status === 'failed') return null;
        }
      } catch {
        // Unreachable, unauthorised, out of credit — all the same answer: this
        // solver did not help, and the item parks for a human.
        return null;
      }
    },
  };
}

/**
 * The solver this worker should use.
 *
 * Read from the environment rather than from the job, because the key is the
 * server's own configuration and a job's frame travels through a pipe and a log.
 * The launcher passes the environment down; nothing about the key reaches a job.
 */
export function captchaSolverFromEnv(env: NodeJS.ProcessEnv = process.env): CaptchaSolver {
  const key = env.RUTEKIT_CAPSOLVER_KEY;
  return key === undefined || key === '' ? noCaptchaSolver : createCapsolver({ apiKey: key });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
