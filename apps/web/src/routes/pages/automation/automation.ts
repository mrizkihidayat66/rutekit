import type { BrowserEngine, JobMode } from '@contracts';

/**
 * The Automation section's shared vocabulary.
 *
 * Kept out of the components so those files stay components-only for the
 * fast-refresh boundary, and so the pages agree on the handful of things they
 * share: the param that names the job being watched, the defaults the launcher
 * opens with, and the two addresses that link them to each other.
 */

/**
 * The URL param that names the job being watched. Both pages read it: the
 * launcher to decide which job its panel follows, the history to decide which
 * job its drawer has open. One param means a job is one address, whichever page
 * the link was copied from.
 */
export const JOB_PARAM = 'job';

/** Where a batch is started, and where a live job can be watched. */
export const BULK_PATH = '/automation';

/** The full history, linked from the panel when nothing is being watched. */
export const LOGS_PATH = '/automation/logs';

/** The proxy pool, linked from the launcher's proxy picker when it is empty. */
export const PROXY_PATH = '/proxy';

/** The SMS pool, linked from a registration job's number-rental picker. */
export const SMS_PATH = '/sms-providers';

/** Form defaults, chosen to match the contract's own defaults. */
export const DEFAULT_ENGINE: BrowserEngine = 'chromium';
export const DEFAULT_MODE: JobMode = 'headless';
export const DEFAULT_CONCURRENCY = '2';
export const DEFAULT_ATTEMPTS = '3';
export const DEFAULT_QUANTITY = '5';

/**
 * How many credentials a pasted blob holds.
 *
 * Blank lines are ignored rather than counted, because a blob copied out of a
 * spreadsheet arrives with a trailing newline and often a gap between blocks —
 * and the count is shown to the operator as "this many will be tried", so an
 * off-by-one from a stray newline would be a wrong promise rather than a typo.
 */
export function countCredentials(payload: string): number {
  let count = 0;
  for (const line of payload.split('\n')) {
    if (line.trim() !== '') count += 1;
  }
  return count;
}

/** A whole number of at least one, or null when the field does not hold one. */
export function positiveInt(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** A trimmed field as the endpoint wants it: the text, or null when it is blank. */
export function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
