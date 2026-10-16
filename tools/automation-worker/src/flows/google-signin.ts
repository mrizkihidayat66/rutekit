import { RetryableError } from '../driver.ts';
import { clickAny, STEP_TIMEOUT_MS } from './shared.ts';
import { waitFor, type FlowContext } from './types.ts';

/**
 * Walking a Google account's sign-in, for the providers that delegate to it (C7c).
 *
 * **Two providers reach their accounts only through Google.** kiro's own sign-in
 * page is four buttons and no form, and qoder's email/password path drops the
 * operator on an Alibaba slider — so the credential that opens either one is a
 * Google account's, and getting it means driving Google. That walk is identical
 * for both, which is why it lives here rather than in each flow: kiro's page and
 * qoder's page differ, and Google's does not.
 *
 * It is four screens on one host, and they arrive in a different order depending
 * on what the account owes:
 *
 *   1. `#identifierId` — the email, then `#identifierNext`;
 *   2. `input[name="Passwd"]` — the password, then `#passwordNext`;
 *   3. the Workspace terms prompt a managed account owes (`#gaplustosNext`);
 *   4. the OAuth consent screen, which hands the browser back to the provider.
 *
 * **Driven as a loop, not as four steps, and that is deliberate.** Which of the
 * four appears is the account's business, not the flow's: a personal account skips
 * the terms prompt, an account that has already consented skips the screen, and
 * Google re-orders them between sign-ins. A flow that waited for them in a fixed
 * sequence would stall on the first one the account did not have. The loop asks
 * what the page *is* on each pass and answers that, which is also what makes the
 * whole thing survive a Google that adds a screen.
 *
 * **Every selector is Google's own, and they are the ones that have not moved in
 * years.** `#identifierId` and `input[name="Passwd"]` are the ids Google's own
 * pages have used across its redesigns; the type is kept as the fallback for the
 * password because a field's type is the one thing that cannot change.
 */

/** Google's email step, and the control that advances it. */
const EMAIL_INPUT = '#identifierId';
const EMAIL_NEXT = '#identifierNext';

/** Google's password step. The name is stable; the type cannot lie. */
const PASSWORD_INPUT = 'input[name="Passwd"]:visible, input[type="password"]:visible';
const PASSWORD_NEXT = '#passwordNext';

/**
 * The prompt a managed Google account owes before it can be used.
 *
 * Seen on a live account: a page headed "Welcome to your new account" with one
 * button, "I understand". A personal account never gets it.
 */
const WORKSPACE_TERMS = '#gaplustosNext, #confirm, button:has-text("I understand"):visible';

/**
 * The OAuth consent screen, by its words.
 *
 * `#submit_approve_access` is Google's own id and is tried first. The word list
 * behind it is what makes this survive a Google that renames the id, and it is
 * deliberately short: these are the labels that screen has used, and a page with
 * none of them is a page this walk has nothing to click on.
 */
const CONSENT = [
  '#submit_approve_access:visible',
  'button:has-text("Continue"):visible',
  'button:has-text("Allow"):visible',
  'button:has-text("Accept"):visible',
];

/**
 * A challenge only a person can pass.
 *
 * Google says it in its own words and shows a captcha or an interstitial, and
 * there is nothing this walk can do about either — so it is reported rather than
 * waited on, and the item parks for an operator like any other challenge (FR-5.3).
 */
const BLOCKING_MARKERS = [
  'captcha',
  'try again later',
  'this browser or app may not be secure',
  'this browser may not be secure',
  'unusual traffic',
  "verify it's you",
  'verify it’s you',
  "confirm it's you",
  'confirm it’s you',
];

/**
 * Whether this URL is Google's sign-in, wherever Google is serving it from.
 *
 * **`accounts.google.com` alone is not enough, and assuming it was cost a real
 * run.** Google redirects a sign-in to the operator's country domain — a live
 * attempt went to `accounts.google.co.id/accounts/SetSID` — so a check against the
 * `.com` hostname reads the redirect as "left Google" and ends the walk in the
 * middle of it, on a page that has nothing to do with the provider. Matching the
 * hostname's shape is what survives the country Google decides to use.
 */
function isGoogleHost(url: string): boolean {
  try {
    return /(^|\.)google\.[a-z.]{2,}$/u.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** How long the whole walk is given before it is called a failure. */
const WALK_TIMEOUT_MS = 180_000;

/** How long one pass waits before re-reading the page. */
const POLL_MS = 700;

export interface GoogleSignInOptions {
  readonly email: string;
  readonly password: string;
  /**
   * Asked at the top of each pass; `true` ends the walk.
   *
   * **Needed when the sign-in's own end state does not leave Google, and that is
   * not a corner case.** kiro's consent screen redirects to a `kiro://` URL, the
   * flow aborts that navigation because the browser cannot follow it, and the page
   * therefore *stays on Google* — so a walk that only watched the URL would decide
   * it had got nowhere, click consent again, and keep doing it. The caller is the
   * one that knows the code arrived, so the caller is the one asked.
   */
  readonly isDone?: () => boolean;
  /**
   * How long the walk may take.
   *
   * Generous by default because a real sign-in includes a round trip to Google's
   * own risk engine, which is not fast and is not under this flow's control.
   */
  readonly timeoutMs?: number;
}

/**
 * Sign in with Google, and return once the browser has left Google's sign-in.
 *
 * Returns rather than throws on success, and the caller decides what "back on the
 * provider" means — qoder's walk ends on `qoder.com`, kiro's ends on a `kiro://`
 * URL the browser cannot navigate to at all, so only the caller knows which one it
 * is waiting for.
 */
export async function driveGoogleSignIn(
  context: FlowContext,
  options: GoogleSignInOptions,
): Promise<void> {
  const { page, signal } = context;
  const deadline = Date.now() + (options.timeoutMs ?? WALK_TIMEOUT_MS);

  context.step('sign in with Google', 'running');

  /**
   * Whether the browser has actually reached Google yet.
   *
   * **The walk cannot treat "not on Google" as finished from the first pass**, and
   * getting that wrong is what made this hang: the provider's own page is loaded
   * first and redirects, so the very first look happens while the browser is still
   * on the provider — and a walk that returned there would report a completed
   * sign-in for a sign-in that had not begun. It waits to have *seen* Google, and
   * only then reads leaving it as the end.
   */
  let sawGoogle = false;

  for (;;) {
    if (signal.aborted) {
      throw new RetryableError('the item was abandoned while signing in to Google');
    }

    const url = page.url();
    const onGoogle = isGoogleHost(url);
    if (onGoogle) sawGoogle = true;

    // The caller's own end state first: a sign-in that finished by handing its
    // code to a custom scheme leaves the browser sitting on Google's consent
    // screen, which looks exactly like a sign-in that has not started yet.
    if (options.isDone?.() === true) {
      context.step('sign in with Google', 'ok', url);
      return;
    }

    // Off Google, having been there: the walk is over, whatever comes next.
    if (sawGoogle && !onGoogle) {
      context.step('sign in with Google', 'ok', url);
      return;
    }

    if (!onGoogle) {
      // Still on the provider's page, waiting for the hand-off. Not an error on
      // its own — a page that never hands off is caught by the deadline below.
      if (Date.now() > deadline) {
        throw new RetryableError(
          `the sign-in never reached Google; the browser is at ${page.url()}`,
        );
      }
      await pause(context, POLL_MS);
      continue;
    }

    const blocked = await blockingMarker(context);
    if (blocked !== null) {
      // Google has decided this sign-in needs a person. Reported rather than
      // waited on: no amount of polling clears a captcha, and the operator's card
      // is the only thing that can.
      throw new RetryableError(
        `Google is asking for a human before it will sign in ("${blocked}"); the item needs an operator`,
      );
    }

    if (await clickAny(context, [WORKSPACE_TERMS], 1_000)) {
      await pause(context, 1_000);
      continue;
    }

    if (await clickAny(context, CONSENT, 1_500)) {
      await pause(context, 1_000);
      continue;
    }

    // The password first, because on the screen that has one the email is already
    // filled and its field is still on the page — asking for the email there would
    // type an address into a form that has moved on.
    if (await fillIfPresent(context, PASSWORD_INPUT, PASSWORD_NEXT, options.password, true)) {
      await pause(context, 1_200);
      continue;
    }

    if (await fillIfPresent(context, EMAIL_INPUT, EMAIL_NEXT, options.email, false)) {
      await pause(context, 1_200);
      continue;
    }

    if (Date.now() > deadline) {
      throw new RetryableError(
        `Google never finished signing in; the browser is at ${page.url()}`,
      );
    }

    await pause(context, POLL_MS);
  }
}

/**
 * Fill a field and advance, or say that this screen is not that step.
 *
 * The typed value is read back before advancing, which is the difference between
 * "the field was filled" and "the fill did nothing". Google's inputs are driven by
 * its own scripts, and a `fill` that lands before they are listening leaves the
 * field empty and the Next button inert — a failure that looks like a wrong
 * password several screens later.
 */
async function fillIfPresent(
  context: FlowContext,
  inputSelector: string,
  nextSelector: string,
  value: string,
  secret: boolean,
): Promise<boolean> {
  const field = context.page.locator(inputSelector).first();
  if ((await field.count()) === 0) return false;
  if (!(await field.isVisible().catch(() => false))) return false;

  await field.fill(value);
  // A secret is compared by length: reading a password back into this process to
  // compare it would put it in memory for no gain, and the length is the only
  // thing a failed fill changes.
  const typed = await field.inputValue().catch(() => '');
  if (secret ? typed.length < value.length : typed.trim() !== value.trim()) return false;

  const next = context.page.locator(nextSelector).first();
  if ((await next.count()) > 0) {
    await next.click().catch(() => undefined);
  } else {
    // No Next this flow recognises, so the keyboard is the fallback — and it is
    // what a person would use.
    await field.press('Enter').catch(() => undefined);
  }
  return true;
}

/** Whether Google is showing something only a person can clear. */
async function blockingMarker(context: FlowContext): Promise<string | null> {
  let text: string;
  try {
    text = (await context.page.innerText('body')).toLowerCase();
  } catch {
    return null;
  }
  for (const marker of BLOCKING_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

/** Wait, in a way the abandonment signal can cut short. */
async function pause(context: FlowContext, ms: number): Promise<void> {
  await waitFor(
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
    context.signal,
    ms + STEP_TIMEOUT_MS,
    'the next screen',
  ).catch(() => undefined);
}
