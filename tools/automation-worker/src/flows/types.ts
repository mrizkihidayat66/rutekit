import type { Page } from 'playwright';
import type { WorkerItem, WorkerJob } from '@rutekit/contracts';

import type { FrameCapture, ImportedAccount, StepStatus } from '../driver.ts';

/**
 * What a provider's sign-in flow is (C7c, ADR-0009).
 *
 * A flow is **a function that drives a page**, not a list of selectors. That is
 * the change from C7b's declarative `FlowScript`: a real sign-in is not a
 * sequence of `fill`/`click` — it waits for a page to settle, reads a code off
 * the screen, decides whether a challenge is in the way, and sometimes needs the
 * operator's answer before it can continue. None of that fits a step list, and a
 * step list that grew enough to express it would be a programming language.
 *
 * So the driver owns the browser and the flow owns the page. Everything above the
 * flow — concurrency, retries, the manual hand-off, the protocol — is identical
 * whichever flow ran, which is what keeps the two separable.
 *
 * **A flow is honest about what it is.** `device-code` is derived from the
 * manifest and drives a flow the manifest actually describes. `generic-login` is
 * a heuristic, and it says so in its name and in its comments. Neither invents a
 * selector for a page nobody has looked at; a provider with no flow fails with a
 * message naming the provider.
 */

/** What a flow is handed: a page, the item, and the ways to report. */
export interface FlowContext {
  readonly page: Page;
  readonly job: WorkerJob;
  readonly item: WorkerItem;
  /** Aborted when this item is abandoned or the job stops. */
  readonly signal: AbortSignal;
  readonly step: (name: string, status: StepStatus, detail?: string | null) => void;
  readonly screenshot: (frame: FrameCapture) => void;
  /**
   * Park the item and ask a human (FR-5.3–5.5).
   *
   * Rejects with `ItemAbandonedError` when the host's deadline passes. A flow that
   * finds a challenge calls this rather than waiting — the deadline is the host's,
   * and the flow is what knows there is something to wait for.
   */
  readonly askManual: (reason: string, screenshotUrl: string | null) => Promise<string>;
  /** Try to solve a challenge automatically, or null when there is no solver (FR-5.3). */
  readonly solveCaptcha: (imageDataUrl: string) => Promise<string | null>;
}

export interface ProviderFlow {
  /** For the log line and the failure message. */
  readonly name: string;
  /**
   * Whether this flow can drive this job.
   *
   * A flow that only works for a browser sign-in must not be handed a device-code
   * job, and the registry asks rather than guessing from the provider id — a
   * provider may declare one login mode today and another later.
   */
  readonly supports: (job: WorkerJob) => boolean;
  importItem(context: FlowContext): Promise<ImportedAccount>;
}

/** The credential half of `email:password` / `email|password`, or the whole string. */
export function splitCredential(raw: string | null): {
  readonly head: string;
  readonly tail: string;
} {
  if (raw === null) return { head: '', tail: '' };
  const colon = raw.indexOf(':');
  const pipe = raw.indexOf('|');
  const at = colon === -1 ? pipe : pipe === -1 ? colon : Math.min(colon, pipe);
  if (at === -1) return { head: raw, tail: '' };
  return { head: raw.slice(0, at), tail: raw.slice(at + 1) };
}

/**
 * Wait for something, in a way the abandonment signal can cut short.
 *
 * `page.waitForTimeout` and `waitForSelector` do not take a signal, so a flow that
 * awaited them directly would keep a browser open after the host had given up —
 * and the item would hold its slot until the job was cancelled. Racing the wait
 * against the signal is what makes abandonment actually stop work.
 */
export function waitFor<T>(
  work: Promise<T>,
  signal: AbortSignal,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${what}`));
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new AbortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        cleanup();
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

/**
 * The signal fired mid-wait.
 *
 * A distinct class so the driver can tell "the host gave up on this item" from
 * "this page never loaded" — the first is not a failure of the attempt and must
 * not spend a retry.
 */
export class AbortError extends Error {
  constructor() {
    super('the item was abandoned while waiting');
    this.name = 'AbortError';
  }
}
