import type { JobMethod } from '@contracts';

/**
 * Reading a job's batch out of the blob the operator pasted (C7b, FR-5.1).
 *
 * Three methods, three shapes of input, and one output: the credentials a job
 * will hand to its worker, each with the masked label the console shows.
 *
 * | method | the blob holds | an item is |
 * |---|---|---|
 * | `bulk-login` | `email:password` or `email\|password` per line | one credential |
 * | `bulk-token` | an issued token, or `access:refresh` | one token pair |
 * | `bulk-regist` | nothing — the accounts do not exist yet | one rented number |
 *
 * **The separator is either one.** A list pasted from a spreadsheet column may
 * use a colon and one typed by hand may use a pipe, and FR-5.1 asks for both. The
 * *first* occurrence splits, because a password may contain either character and
 * the email may not — which is the opposite of the rule the proxy parser uses,
 * and for the opposite reason: there the variable-length part was on the left.
 *
 * **The label is masked here, not later.** The credential is what the job needs
 * and the label is what the console shows, and the two are produced together so
 * there is exactly one place that knows a label is never the raw line.
 *
 * Pure: text in, items out.
 */

export interface BatchEntry {
  /** What the worker is handed. Null for a registration, which has none yet. */
  readonly credential: string | null;
  /** What the console shows. Never the raw line. */
  readonly label: string;
}

/** `name@host` → `n***@host`; anything else is masked to its first character. */
export function maskAccount(raw: string): string {
  const value = raw.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0) {
    // Not an address: a token, or a bare username. Three characters is enough to
    // tell two rows apart and not enough to be one.
    return value.length <= 3 ? '•••' : `${value.slice(0, 2)}•••`;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (domain === '') return '•••';
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** The first `:` or `|`, whichever comes first, and the two halves around it. */
function splitCredential(line: string): { readonly head: string; readonly tail: string } {
  const colon = line.indexOf(':');
  const pipe = line.indexOf('|');
  const at =
    colon === -1 ? pipe : pipe === -1 ? colon : Math.min(colon, pipe);
  if (at === -1) return { head: line, tail: '' };
  return { head: line.slice(0, at), tail: line.slice(at + 1) };
}

/**
 * The lines of a paste that carry something.
 *
 * Blank lines are dropped, and so is a line that is only whitespace — a paste
 * from a spreadsheet column routinely ends with one, and counting it as an item
 * would create a row that can only ever fail.
 */
export function payloadLines(payload: string): string[] {
  return payload
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * A rented number, as a registration job's row is labelled before the account
 * exists.
 *
 * There is no credential to mask here — the number *is* the identity, and it is
 * the only thing an operator could recognise the row by when a registration
 * fails. The digits are derived from the position rather than drawn at random, so
 * the same batch reads the same way twice.
 */
export function rentedLabel(index: number): string {
  const line = String(1000 + index * 7).slice(-4);
  return `+1 (555) ${String(100 + index).padStart(3, '0')}-${line}`;
}

/**
 * The batch a job will run.
 *
 * A registration gets `quantity` items with no credentials, because it creates
 * them. The other two read their batch out of the blob, and the label is masked
 * per method: an email for a sign-in, and the token's own opening characters for
 * a token import — where there is no address to hide behind.
 */
export function batchOf(
  method: JobMethod,
  payload: string,
  quantity: number | null,
): BatchEntry[] {
  if (method === 'bulk-regist') {
    const count = quantity ?? 0;
    return Array.from({ length: count }, (_value, index) => ({
      credential: null,
      label: rentedLabel(index),
    }));
  }

  // A sign-in line is `email:password` and a token line is `access:refresh`; both
  // label the row from the half before the separator, because that is the half a
  // console row can distinguish. The whole line is what the worker is given.
  return payloadLines(payload).map((line) => ({
    credential: line,
    label: maskAccount(splitCredential(line).head),
  }));
}
