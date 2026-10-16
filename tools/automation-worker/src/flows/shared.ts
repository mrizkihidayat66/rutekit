import { ItemAbandonedError, RetryableError, type FrameCapture } from '../driver.ts';
import { detectChallenge } from './challenge.ts';
import { AbortError, waitFor, type FlowContext } from './types.ts';

/**
 * The parts a browser sign-in shares, whatever provider it is against (C7c).
 *
 * `generic-login` and `device-code` each grew their own copy of these, which was
 * defensible while there were two of them and a provider's flow was a page of
 * prose. A provider-specific flow — one written against a markup somebody has
 * actually looked at — needs exactly the same pieces around its own selectors:
 * read the page's text, capture a frame for the operator, notice a challenge,
 * scan for the credential, and turn a wait's failure into the right error class.
 *
 * So they live here, and a flow that knows a provider's markup supplies the part
 * that is genuinely its own — which selectors to use, and in what order.
 *
 * **This is not a flow.** It drives nothing and decides nothing about a provider;
 * every function here is the same for qoder, for kiro, and for a provider nobody
 * has written yet.
 */

/** How long one page is given to reach a state before the step gives up. */
export const STEP_TIMEOUT_MS = 20_000;

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

/** The page's visible text, or empty when the page is mid-navigation. */
export async function bodyText(context: FlowContext): Promise<string> {
  try {
    return await context.page.innerText('body');
  } catch {
    return '';
  }
}

/** A frame of the page as it stands, or null when it cannot be taken. */
export async function captureFrame(context: FlowContext): Promise<FrameCapture | null> {
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
 * Park the item if the page is asking for a human (FR-5.3–5.5).
 *
 * Two paths, and they do different things on purpose.
 *
 * **The solver fills the field itself.** An automatic answer is only useful if it
 * is typed in, so a solved challenge is entered and submitted — and if the flow
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
export async function parkIfChallenged(context: FlowContext): Promise<void> {
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
  await settleAfterManual(context);
}

/** How long a solved challenge is given to let the page move on. */
const CHALLENGE_SETTLE_MS = 10_000;

/**
 * Give the page a moment to move after the operator says they are done.
 *
 * A timeout is deliberately not a failure: a challenge that clears in place
 * leaves the URL where it was, and the step after this one is what actually
 * decides whether the sign-in went through.
 */
export async function settleAfterManual(context: FlowContext): Promise<void> {
  const wasAt = context.page.url();
  await waitFor(
    context.page.waitForURL((url) => url.toString() !== wasAt, { timeout: CHALLENGE_SETTLE_MS }),
    context.signal,
    CHALLENGE_SETTLE_MS + 1_000,
    'the page after the challenge',
  ).catch(() => undefined);
}

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
    await submitForm(context);
    return true;
  }
  return false;
}

/**
 * Submit the form the page is showing: a submit button if there is one, Enter if
 * not, which is the key a person would press anyway.
 *
 * The button list is wider than a sign-in's because this is also used on the
 * screens a provider puts *after* one — a consent prompt, a verification step —
 * where the control says "Continue" or "I understand" rather than "Sign in".
 */
export async function submitForm(context: FlowContext): Promise<void> {
  const button = context.page.locator(
    'button[type="submit"]:visible, input[type="submit"]:visible, button:has-text("Sign in"):visible, button:has-text("Log in"):visible',
  );
  if ((await button.count()) > 0) {
    await button.first().click();
    return;
  }
  const password = context.page.locator('input[type="password"]:visible');
  if ((await password.count()) > 0) {
    await password.first().press('Enter');
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
export async function collectCredential(context: FlowContext): Promise<string | null> {
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
export function asFlowError(cause: unknown, step: string, fallback: string): Error {
  if (cause instanceof AbortError) return new ItemAbandonedError(cause.message);
  return new RetryableError(`${step}: ${cause instanceof Error ? cause.message : fallback}`);
}

export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the page did not change';
}

/**
 * Click the first control that matches, or say that none did.
 *
 * A provider's pages move between steps by clicking a control whose *words* are
 * the stable part and whose id is not: "Continue", "Next", "I understand". The
 * caller supplies the words it is willing to accept, so a flow never clicks
 * something it did not name.
 *
 * **Waited for rather than probed once.** These screens arrive after a
 * navigation, and asking "is it there yet" the instant the previous click
 * returned is a race the flow would lose intermittently — the same class of
 * flake as a missing `await`, and much harder to read. The wait is bounded, and
 * running out of it is not an error: a screen with none of these controls is a
 * screen the account did not owe.
 */
export async function clickAny(
  context: FlowContext,
  selectors: readonly string[],
  timeoutMs = 5_000,
): Promise<boolean> {
  const control = context.page.locator(selectors.join(', ')).first();
  try {
    await control.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return false;
  }
  await control.click();
  return true;
}

/** Wait for the page to leave this URL, without failing when it does not. */
export async function waitToLeave(
  context: FlowContext,
  fromUrl: string,
  ms: number,
  what: string,
): Promise<boolean> {
  try {
    await waitFor(
      context.page.waitForURL((url) => url.toString() !== fromUrl, { timeout: ms }),
      context.signal,
      ms + 1_000,
      what,
    );
    return true;
  } catch {
    return false;
  }
}
