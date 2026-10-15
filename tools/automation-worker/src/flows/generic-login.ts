import {
  ItemAbandonedError,
  RetryableError,
  type FrameCapture,
  type ImportedAccount,
} from '../driver.ts';
import { detectChallenge } from './challenge.ts';
import { AbortError, splitCredential, waitFor, type FlowContext, type ProviderFlow } from './types.ts';

/**
 * A sign-in with an email and a password, driven by heuristic (C7c).
 *
 * **This is a heuristic and it is named like one.** No provider's selectors are
 * hard-coded here, because rutekit has not driven these pages and a selector
 * written from imagination is worse than none: it fails at a line that looks
 * plausible, and the operator reads a step name that suggests the page changed
 * when in fact nobody ever knew what the page looked like.
 *
 * What it does instead is find the parts a sign-in form always has, by their
 * ordinary HTML meaning:
 *
 *   1. open the provider's start page;
 *   2. find a password field — `input[type=password]` is not a guess, it is what
 *      a password field *is*;
 *   3. find the email field near it, by `type=email`, then by `name`, then by
 *      taking the text-like input that comes before the password;
 *   4. fill both and submit — a submit button, or Enter in the password field;
 *   5. if a challenge appears, park the item for a human (FR-5.3);
 *   6. read the credential off the page that follows: an input or textarea whose
 *      value looks like a token, or text that does.
 *
 * Each step reports what it found, so a failure says which part was missing
 * rather than only that something was. That is the difference between a
 * heuristic that is useful and one that is merely opaque.
 *
 * **When it cannot finish, it fails loudly.** A page with no password field is a
 * page this flow does not understand, and it says so — it does not fall through
 * to "imported" with an empty credential.
 */

/** How long one page is given to reach a state before the step gives up. */
const STEP_TIMEOUT_MS = 20_000;

/** How long a sign-in is given to land after submitting. */
const SIGN_IN_TIMEOUT_MS = 60_000;

/**
 * What a credential looks like on a page.
 *
 * Deliberately narrow: a vendor-prefixed key, a JWT, or a long opaque run with a
 * digit in it. The same reasoning as the telemetry redactor's patterns, from the
 * other direction — there the shapes are what must never be written down, here
 * they are the only thing worth reading up.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk|pk|gsk|xai|api)[-_][A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{32,}={0,2}\b/,
];

/** The password field, which is the one element a sign-in form must have. */
const PASSWORD_SELECTOR = 'input[type="password"]:visible';

export const genericLogin: ProviderFlow = {
  name: 'generic-login',

  // A browser sign-in and nothing else. A device-code job is a different flow,
  // and handing it this one would fill a password into a page that wants a code.
  supports: (job) => job.automation?.login === 'browser' && job.method === 'bulk-login',

  async importItem(context: FlowContext): Promise<ImportedAccount> {
    const { page, job, item, signal, step } = context;
    const automation = job.automation;
    if (automation === null) {
      throw new Error(`${job.providerId} declares no automation flow`);
    }

    const { head: email, tail: password } = splitCredential(item.credential);
    if (email === '' || password === '') {
      // `email:password` is the shape this flow reads. A bare token is what
      // `bulk-token` is for, and saying so beats filling an empty password.
      throw new Error('this flow needs `email:password` and the item has neither');
    }

    step('open', 'running');
    try {
      await waitFor(page.goto(automation.startUrl), signal, STEP_TIMEOUT_MS, 'the start page');
    } catch (cause) {
      throw asFlowError(cause, 'open', 'the start page did not load');
    }
    step('open', 'ok', page.url());

    // A page that is already asking for something only a person can give has
    // nothing for this flow to do, and waiting for a password field that will
    // never appear would spend the whole step timeout for no reason.
    await parkIfChallenged(context);

    step('find the form', 'running');
    const form = await waitFor(
      page.waitForSelector(PASSWORD_SELECTOR, { timeout: STEP_TIMEOUT_MS }),
      signal,
      STEP_TIMEOUT_MS + 1_000,
      'a password field',
    ).catch(() => null);

    if (form === null) {
      // Not a retryable failure: the page is what it is, and another attempt will
      // find the same page. A retry here would spend the item's budget on a
      // certainty.
      throw new Error(
        `${job.providerId} showed no password field at ${page.url()}, so this flow cannot sign in`,
      );
    }
    step('find the form', 'ok', 'a password field is on the page');

    const emailSelector = await findEmailField(context);
    if (emailSelector === null) {
      throw new Error(
        `${job.providerId} has a password field but no field this flow recognises as the email`,
      );
    }

    step('sign in', 'running');
    try {
      await page.fill(emailSelector, email);
      await page.fill(PASSWORD_SELECTOR, password);
      await submit(context);
    } catch (cause) {
      throw asFlowError(cause, 'sign in', 'the form could not be filled');
    }
    step('sign in', 'ok');

    step('wait for the dashboard', 'running');
    try {
      // A sign-in is a navigation, and the page that follows is the one with the
      // credential on it. Waiting for the URL to leave the sign-in page is the
      // most portable signal there is — a success selector would be a guess.
      await waitFor(
        page.waitForURL((url) => url.toString() !== automation.startUrl, {
          timeout: SIGN_IN_TIMEOUT_MS,
        }),
        signal,
        SIGN_IN_TIMEOUT_MS + 1_000,
        'the page after signing in',
      );
    } catch (cause) {
      // The page stayed put. That is either a challenge nobody spotted, or
      // credentials the provider refused — and those want different answers, so
      // the challenge check runs before the failure is reported.
      await parkIfChallenged(context);
      throw new RetryableError(
        `signing in to ${job.providerId} did not go anywhere: ${describe(cause)}`,
      );
    }
    step('wait for the dashboard', 'ok', page.url());

    await parkIfChallenged(context);

    step('collect', 'running');
    const credential = await collectCredential(context);
    if (credential === null) {
      throw new Error(
        `${job.providerId} signed in but no credential could be read from ${page.url()}`,
      );
    }
    step('collect', 'ok');

    return { credential, label: item.label };
  },
};

/**
 * The email field, found by what it is before what it is called.
 *
 * `type=email` is a fact about the field; a `name` or `id` containing "email" is
 * a convention; and the first visible text input is the fallback a two-field
 * sign-in form almost always satisfies. Tried in that order because each one is
 * weaker than the last.
 *
 * Locators rather than a DOM query in `evaluate`, which is the difference between
 * this and a page-side script: `evaluate` would need DOM types in a Node process
 * that has no DOM, and Playwright's locators already wait for the element and
 * already know how to say whether it is there.
 */
async function findEmailField(context: FlowContext): Promise<string | null> {
  const candidates = [
    'input[type="email"]:visible',
    'input[name*="email" i]:visible',
    'input[id*="email" i]:visible',
    'input[name*="user" i]:visible',
    'input[id*="user" i]:visible',
    // The fallback: the first visible input that is not the password and not a
    // hidden field. On a sign-in form that is the email.
    'input:not([type="password"]):not([type="hidden"]):not([type="submit"]):visible',
  ];

  for (const selector of candidates) {
    if ((await context.page.locator(selector).count()) > 0) return selector;
  }
  return null;
}

/** Submit the form: a submit button if there is one, Enter in the password if not. */
async function submit(context: FlowContext): Promise<void> {
  const button = context.page.locator(
    'button[type="submit"]:visible, input[type="submit"]:visible, button:has-text("Sign in"):visible, button:has-text("Log in"):visible',
  );
  if ((await button.count()) > 0) {
    await button.first().click();
    return;
  }
  // No button this flow recognises, so the keyboard is the fallback — and it is
  // the one a person would use anyway.
  await context.page.press(PASSWORD_SELECTOR, 'Enter');
}

/**
 * Park the item if the page is asking for a human (FR-5.3–5.5).
 *
 * Two paths, and they do different things on purpose.
 *
 * **The solver fills the field itself.** An automatic answer is only useful if it
 * is typed in, so a solved challenge is entered and submitted — and if this flow
 * cannot find a field to put it in, the solve was wasted and the item goes to a
 * human anyway. Guessing where a captcha goes is the same class of guess as
 * guessing a password selector, so the search is narrow and a miss is not fatal.
 *
 * **The operator does not.** They solve the challenge in the live browser through
 * a manual session (FR-5.7) — the flow has nothing to type on their behalf — and
 * their answer is an acknowledgement that it is done. Filling a field here would
 * be a second submission on a form they have already submitted.
 *
 * The frame travels with the ask so the operator's card shows the challenge, and
 * the flow then waits: the host owns the deadline, and the answer or the
 * abandonment arrives as one of two frames.
 */
async function parkIfChallenged(context: FlowContext): Promise<void> {
  const verdict = detectChallenge(await bodyText(context));
  if (!verdict.detected) return;

  context.step('challenge', 'running', `the page says "${verdict.marker ?? ''}"`);

  const frame = await captureFrame(context);
  if (frame !== null) {
    const solved = await context.solveCaptcha(frame.frameUrl);
    if (solved !== null && (await enterChallengeAnswer(context, solved))) {
      context.step('challenge', 'ok', 'solved automatically');
      return;
    }
  }

  const answer = await context.askManual(
    `challenge: ${verdict.marker ?? 'unknown'}`,
    frame?.frameUrl ?? null,
  );
  context.step('challenge', 'ok', `the operator answered "${answer}"`);

  // The operator solved it in the browser, so the page should have moved on.
  // Waited for rather than assumed, and a timeout is not a failure: some
  // challenges clear in place, and the steps after this one will say whether the
  // page actually let the sign-in through.
  const wasAt = context.page.url();
  await waitFor(
    context.page.waitForURL((url) => url.toString() !== wasAt, { timeout: CHALLENGE_SETTLE_MS }),
    context.signal,
    CHALLENGE_SETTLE_MS + 1_000,
    'the page after the challenge',
  ).catch(() => undefined);
}

/** How long a solved challenge is given to let the page move on. */
const CHALLENGE_SETTLE_MS = 10_000;

/**
 * Type a solved captcha into the field and submit it.
 *
 * Narrow on purpose: a field named for a captcha or a verification code is the
 * shape this looks for, and anything else is a miss the caller falls back from.
 * A broader search would eventually fill the password field with a captcha.
 */
async function enterChallengeAnswer(context: FlowContext, answer: string): Promise<boolean> {
  const candidates = [
    'input[name*="captcha" i]:visible',
    'input[id*="captcha" i]:visible',
    'input[name*="verify" i]:visible',
    'input[id*="verify" i]:visible',
    'input[placeholder*="code" i]:visible',
    'input[autocomplete="one-time-code"]:visible',
  ];

  for (const selector of candidates) {
    if ((await context.page.locator(selector).count()) === 0) continue;
    await context.page.fill(selector, answer);
    await submit(context);
    return true;
  }
  return false;
}

/** The page's visible text, or empty when the page is mid-navigation. */
async function bodyText(context: FlowContext): Promise<string> {
  try {
    return await context.page.innerText('body');
  } catch {
    return '';
  }
}

/** A frame of the page as it stands, or null when it cannot be taken. */
async function captureFrame(context: FlowContext): Promise<FrameCapture | null> {
  try {
    const jpeg = await context.page.screenshot({ type: 'jpeg', quality: 60 });
    const size = context.page.viewportSize();
    return {
      frameUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      width: size?.width ?? 1280,
      height: size?.height ?? 720,
    };
  } catch {
    return null;
  }
}

/**
 * The credential the signed-in page is showing.
 *
 * Two places, in order: a field's own value — an API-key page shows the key in a
 * readonly input, which is the shape every one of them uses — and then the page's
 * text, for a provider that prints it instead. The field is tried first because
 * reading a value out of an input cannot pick up surrounding prose.
 *
 * The field walk is done from this side with `inputValue()` rather than with a
 * page-side `evaluate`, which is what keeps this file free of DOM types.
 */
async function collectCredential(context: FlowContext): Promise<string | null> {
  const fields = context.page.locator('input, textarea');
  const count = Math.min(await fields.count(), 50);

  for (let index = 0; index < count; index += 1) {
    // `inputValue` throws on an element that is not a field, which a `textarea`
    // matched by the same selector never is — the catch is for the odd element
    // that has gone away between the count and the read.
    const value = await fields.nth(index).inputValue().catch(() => '');
    const trimmed = value.trim();
    if (trimmed.length >= 20 && looksLikeCredential(trimmed)) return trimmed;
  }

  const text = await bodyText(context);
  for (const pattern of CREDENTIAL_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return match[0];
  }
  return null;
}

/** Whether a string is credential-shaped rather than, say, a long page title. */
function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

/** A step's failure, as the kind of error the flow's caller should see. */
function asFlowError(cause: unknown, step: string, fallback: string): Error {
  if (cause instanceof AbortError) return new ItemAbandonedError(cause.message);
  return new RetryableError(`${step}: ${cause instanceof Error ? cause.message : fallback}`);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the page did not change';
}
