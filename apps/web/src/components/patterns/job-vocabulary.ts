import type {
  BrowserEngine,
  Job,
  JobItem,
  JobMethod,
  JobMode,
  JobStatus,
  JobStepStatus,
} from '@contracts';

import type { Tone } from './tone.ts';

/**
 * The Automation section's words.
 *
 * Three pages speak about the same two records — an import job and the proxy its
 * browsers leave through — so the labels, the tones and the filter lists live
 * here once rather than being re-spelled per page and drifting apart. Nothing
 * here renders; it is pure data plus a few lookups, which keeps it out of the
 * fast-refresh boundary.
 *
 * `needs_manual` is the state this vocabulary exists to get right. It is not a
 * failure (FR-5.4): a job sitting in it is alive, waiting on a person, and an
 * operator scanning a history table has to be able to tell it from `failed` at a
 * glance — which is why the two get different tones and different words rather
 * than both reading as "did not succeed".
 */

/* ---- Job status ---- */

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_manual: 'Needs a hand',
  paused: 'Paused',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const JOB_STATUS_TONES: Record<JobStatus, Tone> = {
  queued: 'neutral',
  running: 'accent',
  needs_manual: 'warning',
  paused: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/** How a status reads in a sentence, for a tooltip or an empty-state hint. */
export const JOB_STATUS_HINTS: Record<JobStatus, string> = {
  queued: 'Accepted and waiting for a worker slot.',
  running: 'A browser is working through the credentials.',
  needs_manual: 'A challenge is waiting for an operator to solve it in the live preview.',
  paused: 'Held by an operator. The workers are idle, but the job is not over.',
  succeeded: 'Every credential in the batch was imported.',
  failed: 'At least one credential could not be imported.',
  cancelled: 'Stopped by an operator before it finished.',
};

/** Most-watched first, so a filter list reads in the order an operator thinks. */
export const JOB_STATUSES: readonly JobStatus[] = [
  'running',
  'needs_manual',
  'paused',
  'queued',
  'succeeded',
  'failed',
  'cancelled',
];

/**
 * The states that are going to move on their own — exactly the set a job poll is
 * attached to. Kept here so the badge that says "live" and the hook that decides
 * whether to keep reading agree on what live means.
 */
export const LIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'needs_manual'];

export function isLiveJob(status: JobStatus): boolean {
  return LIVE_JOB_STATUSES.includes(status);
}

/** A job that will not change again unless an operator asks it to. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminalJob(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

export function isJobStatus(value: string): value is JobStatus {
  return JOB_STATUSES.includes(value as JobStatus);
}

export const JOB_STATUS_OPTIONS: readonly {
  readonly value: 'all' | JobStatus;
  readonly label: string;
}[] = [
  { value: 'all', label: 'Any status' },
  ...JOB_STATUSES.map((status) => ({ value: status, label: JOB_STATUS_LABELS[status] })),
];

/* ---- Job step status ---- */

export const JOB_STEP_STATUS_LABELS: Record<JobStepStatus, string> = {
  pending: 'Not yet',
  running: 'Running',
  ok: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

export const JOB_STEP_STATUS_TONES: Record<JobStepStatus, Tone> = {
  pending: 'neutral',
  running: 'accent',
  ok: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

/* ---- Job control ---- */

export const JOB_ACTIONS = ['pause', 'resume', 'cancel', 'retry_failed'] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export const JOB_ACTION_LABELS: Record<JobAction, string> = {
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  retry_failed: 'Retry failures',
};

/**
 * How loud each control is. Cancel is the only one that ends work, so it is the
 * only one drawn as a danger; retry looks like resume but is not, because it
 * throws away what the failed credentials already did and starts them again.
 */
export const JOB_ACTION_VARIANTS: Record<JobAction, 'primary' | 'secondary' | 'danger'> = {
  pause: 'secondary',
  resume: 'primary',
  cancel: 'danger',
  retry_failed: 'secondary',
};

/**
 * Which controls a job in this state offers.
 *
 * The bar is derived from the status rather than shown in full and disabled: a
 * "Resume" on a running job is a button whose only honest behaviour is to do
 * nothing, and four of those train an operator to ignore the bar. Retry is
 * offered on a cancelled job as well as a failed one, because a cancellation
 * usually leaves the same credentials unimported that a failure does.
 */
export function jobActions(status: JobStatus): readonly JobAction[] {
  switch (status) {
    case 'queued':
      return ['cancel'];
    case 'running':
    case 'needs_manual':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'failed':
    case 'cancelled':
      return ['retry_failed'];
    case 'succeeded':
      return [];
  }
}

/* ---- Browser engine ---- */

export const ENGINE_LABELS: Record<BrowserEngine, string> = {
  chromium: 'Chromium',
  camoufox: 'Camoufox',
};

export const ENGINE_HINTS: Record<BrowserEngine, string> = {
  chromium: 'Stock headless Chromium. The fastest to start, and the one most sign-in flows expect.',
  camoufox: 'A hardened Firefox build. Slower to launch, but it presents as an ordinary browser.',
};

export const ENGINES: readonly BrowserEngine[] = ['chromium', 'camoufox'];

export function isBrowserEngine(value: string): value is BrowserEngine {
  return ENGINES.includes(value as BrowserEngine);
}

/* ---- Job method ---- */

/**
 * The three ways a batch of credentials can arrive.
 *
 * The words are chosen to say what the job *does*, not what it is called in the
 * API: an operator scanning a history wants to know whether a batch signed in,
 * registered, or merely posted keys — `bulk-regist` names the endpoint, not the
 * act.
 */
export const JOB_METHOD_LABELS: Record<JobMethod, string> = {
  'bulk-login': 'Sign in',
  'bulk-regist': 'Register',
  'bulk-token': 'Import tokens',
};

export const JOB_METHOD_HINTS: Record<JobMethod, string> = {
  'bulk-login':
    'A browser signs each credential in and reads back the key the provider hands it.',
  'bulk-regist':
    'A browser creates each account from scratch, renting a phone number to receive the code.',
  'bulk-token': 'Tokens that were issued elsewhere are posted straight in. No browser is opened.',
};

export const JOB_METHODS: readonly JobMethod[] = ['bulk-login', 'bulk-regist', 'bulk-token'];

export function isJobMethod(value: string): value is JobMethod {
  return JOB_METHODS.includes(value as JobMethod);
}

/* ---- Job mode ---- */

export const JOB_MODE_LABELS: Record<JobMode, string> = {
  headed: 'Headed',
  headless: 'Headless',
};

export const JOB_MODE_HINTS: Record<JobMode, string> = {
  headed:
    'The browser draws a window on the automation host. Slower, and only sensible on a machine with a display — but it is what a challenge needs when a solver has to look at it.',
  headless:
    'The browser runs without a window. The default, and the only mode that makes sense on a server.',
};

export const JOB_MODES: readonly JobMode[] = ['headless', 'headed'];

export function isJobMode(value: string): value is JobMode {
  return JOB_MODES.includes(value as JobMode);
}

/**
 * How a job ran, in one line: what it did and what it did it with.
 *
 * A token import has no engine and no mode, so it says so rather than printing
 * a dash where a browser would be — the absence is the point, and it is the
 * quickest way for an operator to tell a batch that posted keys from one that
 * drove a browser.
 */
export function jobRunLabel(job: Job): string {
  const method = JOB_METHOD_LABELS[job.method];
  if (job.engine === null) return `${method} · no browser`;
  const engine = ENGINE_LABELS[job.engine];
  return job.mode === null ? `${method} · ${engine}` : `${method} · ${engine} · ${JOB_MODE_LABELS[job.mode]}`;
}

/* ---- Progress ---- */

/**
 * How far a job has got, counting only the credentials that reached an end.
 *
 * In flight is deliberately not counted as progress: a job that has parked half
 * its batch on a human has not half-finished, it has stalled, and a bar that
 * crept forward for it would say the opposite.
 */
export function jobProgress(job: Job): { readonly done: number; readonly ratio: number } {
  const done = job.succeeded + job.failed;
  return { done, ratio: job.total > 0 ? done / job.total : 0 };
}

/**
 * The credential a panel should be showing: the one blocked on a human if there
 * is one, otherwise the one a worker is on, otherwise the first in the batch.
 *
 * A job parked on a challenge has several items in play and only one of them is
 * the reason the job is standing still, so that one wins outright — otherwise
 * the step timeline would show a credential that is quietly waiting its turn.
 */
export function focusedItem(job: Job): JobItem | undefined {
  return (
    job.items.find((item) => item.status === 'needs_manual') ??
    job.items.find((item) => item.status === 'running') ??
    job.items[0]
  );
}

/** The credential currently parked on a human, if any. */
export function manualItem(job: Job): JobItem | undefined {
  return job.items.find((item) => item.status === 'needs_manual');
}

/** The step a credential is on right now, for the preview's caption. */
export function currentStep(item: JobItem | undefined): JobItem['steps'][number] | undefined {
  if (item === undefined) return undefined;
  return (
    item.steps.find((step) => step.status === 'running') ??
    item.steps.find((step) => step.status === 'failed') ??
    item.steps[item.steps.length - 1]
  );
}
