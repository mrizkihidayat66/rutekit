/**
 * The vocabulary the two ways into the console share.
 *
 * Login and the first-run wizard are one subject — who may open this instance —
 * so they keep their copy and their rules in one place rather than each spelling
 * out what a password is.
 */

/** The contract's floor (`setupBodySchema`), restated so the form can enforce it before sending. */
export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_RULE =
  'At least eight characters. Length is the only rule — a passphrase beats a short scramble.';

/**
 * Said on the login page because its absence is otherwise a search: an operator
 * looking for a "forgot password" link should be told there is not one rather
 * than left to conclude the page is broken.
 */
export const SESSION_NOTE =
  'There are no accounts and no reset link. This console is single-user by design.';

/** What is wrong with the password, or `null`. Shared so both forms complain identically. */
export function passwordProblem(password: string): string | null {
  if (password === '') return 'Enter a password.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password needs at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
  }
  return null;
}
