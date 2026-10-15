import type { WorkerItem, WorkerJob } from '@rutekit/contracts';

/**
 * What the worker asks a browser to do (C7b, ADR-0009).
 *
 * The driver is the seam between "how a batch is run" and "how one account is
 * obtained". Everything above it — the concurrency, the retry loop, the manual
 * hand-off, the stdio protocol — is identical whether the browser is a real
 * Chromium or a fake, which is what makes the whole job lifecycle testable
 * without a browser and without a provider.
 *
 * **One item in, one account out.** A driver is not asked to walk the batch; it
 * is asked to obtain one credential, and it reports progress while it does. That
 * is the boundary ADR-0009 draws: the flow above the driver is rutekit's, the
 * flow inside it is the provider's, and the provider's changes without a
 * definition changing.
 *
 * **Abandonment is cooperative.** The host abandons an item when its manual
 * deadline passes, and it does that by aborting the signal and rejecting the
 * pending `askManual` — a browser part-way through a sign-in cannot be frozen, so
 * the driver is expected to notice and unwind. A driver that ignores the signal
 * is a driver that holds an account slot until the job is cancelled, which is why
 * the signal is part of the contract rather than a courtesy.
 */

/** The statuses a step can carry, matching the contract's `jobStepSchema`. */
export type StepStatus = 'running' | 'ok' | 'failed' | 'skipped';

/** One preview frame, as the console's `preview_frame` frame wants it. */
export interface FrameCapture {
  readonly frameUrl: string;
  readonly width: number;
  readonly height: number;
}

export interface ImportContext {
  readonly job: WorkerJob;
  readonly item: WorkerItem;
  /**
   * Aborted when this item is abandoned, or when the whole job is.
   *
   * A driver should check it between steps and pass it to anything that accepts
   * one — a navigation, a wait, a network call. Nothing here can force a driver
   * to stop, so this is the mechanism and the driver's discipline is the rest.
   */
  readonly signal: AbortSignal;
  /** Report one step of this item. Fire and forget; the flow stamps the index. */
  readonly step: (name: string, status: StepStatus, detail?: string | null) => void;
  /** Offer a frame for the live preview (FR-5.2). */
  readonly screenshot: (frame: FrameCapture) => void;
  /**
   * Park the item and ask a human to solve something (FR-5.3–5.5).
   *
   * Resolves with the operator's answer. Rejects with `ItemAbandonedError` when
   * the host's deadline passes, which is the driver's cue to give up on this item
   * and let the flow move on. A driver that cannot make progress without help
   * must call this rather than waiting — the flow is what knows the deadline.
   */
  readonly askManual: (reason: string, screenshotUrl: string | null) => Promise<string>;
}

/** The account a driver obtained. The credential is what the job exists for. */
export interface ImportedAccount {
  /** The blob the provider-account store encrypts: a key, a token pair, a cookie jar. */
  readonly credential: string;
  /** The masked identity for the console's row, e.g. `a***@gmail.com`. */
  readonly label: string;
}

export interface BrowserDriver {
  /** For the log line that says which engine ran. */
  readonly name: string;
  /** Obtain one account, or throw. */
  importItem(context: ImportContext): Promise<ImportedAccount>;
  /** Release everything. Called once, however the job ended. */
  close(): Promise<void>;
}

/**
 * Raised when the host gave up on an item — a manual deadline, or a cancellation.
 *
 * A class rather than a bare error so the flow can tell "the operator did not
 * answer in time" from "the provider refused this credential". The first is not a
 * failure of the attempt and must not spend a retry; the second is.
 */
export class ItemAbandonedError extends Error {
  constructor(reason = 'the item was abandoned') {
    super(reason);
    this.name = 'ItemAbandonedError';
  }
}

/**
 * Whether an attempt is worth repeating (FR-5.6).
 *
 * The default is **no**, and the direction matters: a credential the provider
 * rejected will be rejected again, and retrying it burns an attempt and a slot
 * for nothing. A driver that knows an attempt failed in a way another try could
 * fix — a timeout, a flaky page, a challenge nobody answered — says so by
 * throwing `RetryableError`.
 */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Whether this error is one the flow may spend another attempt on. */
export function isRetryable(error: unknown): boolean {
  return error instanceof RetryableError;
}
