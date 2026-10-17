import { randomUUID } from 'node:crypto';

import { ItemAbandonedError, RetryableError, type ImportedAccount } from '../driver.ts';
import { driveGoogleSignIn } from './google-signin.ts';
import { asFlowError, clickAny, STEP_TIMEOUT_MS } from './shared.ts';
import {
  AbortError,
  splitCredential,
  waitFor,
  type FlowContext,
  type ProviderFlow,
} from './types.ts';

/**
 * Qoder's sign-in, which is Google's, and the token that comes out of it (C7c).
 *
 * **Qoder has an email-and-password form and it is not the one to use.** Filling
 * it works — the email is accepted, then the password — and then the page hands
 * the operator an Alibaba slider puzzle (`#aliyunCaptcha-captcha-wrapper`) that
 * only a person or a paid solver can pass. The Google button beside that form
 * reaches the same account with no challenge at all, which is why this flow takes
 * the Google path and why the email/password one is not kept as a fallback: a
 * fallback that reliably ends at a captcha is not a fallback.
 *
 * **The credential is not on the page you land on.** Signing in shows an account
 * page with a name and a plan and no key anywhere; every settings route was walked
 * and none of them carries one. What qoder exposes is a **Personal Access Token**,
 * created on demand at `/account/integrations`, and it is shown exactly once. Its
 * own words: "Access Tokens enable programmatic access to your Qoder account...
 * for headless integrations, like using the Qoder CLI."
 *
 * **And the PAT is not the credential either.** It is exchanged, once, for the
 * token a client actually uses:
 *
 *   POST https://openapi.qoder.sh/api/v1/jobToken/exchange  {personal_token}
 *     -> { token, refresh_token }
 *
 * That exchange is what this flow returns, because it is what the account is
 * worth: a PAT that was never exchanged is a string nobody has validated, and
 * validating it here is what makes a stored account a working one rather than a
 * row that fails at its first request.
 *
 * **Every selector was read off the real pages**, and the PAT's shape (`pt-`) off
 * a real token — which is also why `collectCredential` would not have found it:
 * that helper looks for the `sk-`/JWT family, and a qoder token is neither.
 */

/** Where qoder's account pages live, and where the token is created. */
const INTEGRATIONS_PATH = '/account/integrations';

/** The control that hands the sign-in to Google, found by its words. */
const GOOGLE_CONTROL = 'a:has-text("Sign in with Google"):visible, a[href*="/sso/login/google"]:visible';

/** The control that opens the token form, and the fields inside it. */
const NEW_TOKEN = 'button:has-text("New Token"):visible';
const TOKEN_NAME = 'input[placeholder="Enter access token name"]';
const TOKEN_EXPIRY = 'input[placeholder="Set an expiration date"]';
const CREATE_TOKEN = 'button:has-text("Create"):not([disabled]):visible';

/**
 * The exchange that turns a PAT into the token a client uses.
 *
 * A qoder endpoint, called from here rather than from the console, because the PAT
 * only exists inside this browser session — it is shown once and never again, so
 * whoever holds it is whoever must spend it.
 *
 * It goes through `fetch` rather than through the browser, which is why a test
 * cannot serve it the way it serves the pages: Playwright's routing is inside the
 * browser and this call is not. The override exists for that reason and is the
 * same kind of seam as the device flow's approval window — an interval or an
 * endpoint a test must move to reach a branch, not a knob an operator needs.
 */
const PAT_EXCHANGE_DEFAULT = 'https://openapi.qoder.sh/api/v1/jobToken/exchange';

function patExchangeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['RUTEKIT_QODER_EXCHANGE_URL'];
  return override === undefined || override === '' ? PAT_EXCHANGE_DEFAULT : override;
}

/** What a qoder Personal Access Token looks like, as the dialog prints it. */
const PAT_PATTERN = /\bpt-[A-Za-z0-9_-]{16,}\b/;

/** The calendar's year-forward control. */
const NEXT_YEAR = 'button[aria-label*="Next year"], .ant-picker-header-super-next-btn';

/** A day the calendar will let the operator pick. */
const DAY_CELL =
  '.ant-picker-cell-in-view:not(.ant-picker-cell-disabled) .ant-picker-cell-inner';

/** How long the token dialog is given to appear after Create. */
const TOKEN_DIALOG_MS = 30_000;

export const qoderGoogle: ProviderFlow = {
  name: 'qoder-google',

  supports: (job) =>
    job.providerId === 'qoder' &&
    job.automation?.login === 'browser' &&
    job.method === 'bulk-login',

  async importItem(context: FlowContext): Promise<ImportedAccount> {
    const { page, job, item, signal, step } = context;
    const automation = job.automation;
    if (automation === null) {
      throw new Error(`${job.providerId} declares no automation flow`);
    }

    const { head: email, tail: password } = splitCredential(item.credential);
    if (email === '' || password === '') {
      throw new Error('this flow needs `email:password` and the item has neither');
    }

    step('open', 'running');
    try {
      await waitFor(page.goto(automation.startUrl), signal, STEP_TIMEOUT_MS, 'the sign-in page');
    } catch (cause) {
      throw asFlowError(cause, 'open', 'the sign-in page did not load');
    }
    step('open', 'ok', page.url());

    // Start where a person starts, and press the button they press.
    //
    // The manifest names qoder's sign-in page rather than its SSO endpoint, so
    // the hand-off is a click on the page's own control instead of a URL this
    // flow has to know. That matters for a reason beyond appearances: the SSO URL
    // carries a callback and a client id, and a flow that spells them out breaks
    // the day qoder changes them — whereas a flow that clicks the button follows
    // wherever qoder now points it.
    step('choose Google', 'running');
    try {
      await waitFor(
        page.waitForSelector(GOOGLE_CONTROL, { timeout: STEP_TIMEOUT_MS }),
        signal,
        STEP_TIMEOUT_MS + 1_000,
        "qoder's Google control",
      );
    } catch (cause) {
      if (cause instanceof AbortError) throw new ItemAbandonedError(cause.message);
      throw new Error(
        `${job.providerId} showed no Google control at ${page.url()}, so this flow cannot sign in`,
      );
    }
    try {
      await page.locator(GOOGLE_CONTROL).first().click();
      await waitFor(
        page.waitForURL((url) => !url.hostname.endsWith('qoder.com'), { timeout: STEP_TIMEOUT_MS }),
        signal,
        STEP_TIMEOUT_MS + 1_000,
        "Google's sign-in page",
      );
    } catch (cause) {
      throw asFlowError(cause, 'choose Google', "qoder's Google control could not be used");
    }
    step('choose Google', 'ok', page.url());

    await driveGoogleSignIn(context, { email, password });

    step('wait for qoder', 'running');
    try {
      await waitFor(
        page.waitForURL((url) => url.hostname.endsWith('qoder.com'), { timeout: 60_000 }),
        signal,
        61_000,
        'qoder after the Google sign-in',
      );
    } catch (cause) {
      throw asFlowError(cause, 'wait for qoder', 'qoder never came back from Google');
    }
    step('wait for qoder', 'ok', page.url());

    const personalToken = await createPersonalToken(context);
    const exchanged = await exchangePersonalToken(context, personalToken);

    // Recorded beside the token because the chat codec signs with them, and this
    // is the only moment the flow has both the token and the account to store.
    const identity = await fetchIdentity(exchanged.securityOauthToken);
    const machineId = randomUUID();

    return {
      credential: JSON.stringify({
        personalToken,
        ...exchanged,
        ...identity,
        machineId,
        email,
      }),
      label: item.label,
    };
  },
};

/**
 * Create a Personal Access Token and read it out of the dialog.
 *
 * **The date is required, and that is the whole difficulty.** Create stays
 * `disabled` until an expiry is chosen, and the field is a picker rather than a
 * text box — typing into it leaves the form invalid and the button dead, which
 * looks like a broken page rather than an unfilled field. So the calendar is
 * opened and a day is clicked, the way a person does it: the year is advanced
 * first, because a token that expires in a month is worse than useless for an
 * account an operator is stockpiling.
 */
async function createPersonalToken(context: FlowContext): Promise<string> {
  const { page, step } = context;

  step('create a token', 'running');
  try {
    await page.goto(`https://qoder.com${INTEGRATIONS_PATH}`, { waitUntil: 'domcontentloaded' });
    if (!(await clickAny(context, [NEW_TOKEN], STEP_TIMEOUT_MS))) {
      throw new Error(`qoder showed no New Token control at ${page.url()}`);
    }

    await page.locator(TOKEN_NAME).first().fill(`rutekit-${Date.now().toString(36)}`);

    // The expiry: one year from today, named as a date rather than taken as
    // "whatever the calendar offers last".
    //
    // **The two agree today, and that is the reason to name it.** qoder caps the
    // calendar at exactly a year out, so the last enabled cell in view *is* that
    // cap — which means a flow that clicked the last cell would store the right
    // date for a reason it did not choose. Let the cap move and it stores a date
    // nobody picked, silently, because nothing in the flow ever said what it
    // wanted.
    const target = oneYearFromToday();

    await page.locator(TOKEN_EXPIRY).first().click();
    const nextYear = page.locator(NEXT_YEAR);
    if ((await nextYear.count()) > 0) {
      await nextYear.first().click().catch(() => undefined);
      await page.waitForTimeout(500);
    }

    const days = page.locator(DAY_CELL);
    if ((await days.count()) === 0) {
      throw new Error('qoder’s expiry picker offered no selectable day');
    }
    // The same day-of-month, a year on. When that day does not exist a year out —
    // 29 February is the only one — the last day on offer is the same intent, one
    // day short, and is what the fallback takes.
    const wanted = days.filter({ hasText: new RegExp(`^${String(target.getDate())}$`, 'u') });
    await ((await wanted.count()) > 0 ? wanted.first() : days.last()).click();
    await page.waitForTimeout(700);

    if (!(await clickAny(context, [CREATE_TOKEN], STEP_TIMEOUT_MS))) {
      throw new Error(
        `qoder's Create stayed disabled after an expiry was chosen, at ${page.url()}`,
      );
    }
  } catch (cause) {
    throw asFlowError(cause, 'create a token', 'the token form could not be filled');
  }

  const personalToken = await readPrintedToken(context);

  step('create a token', 'ok');
  return personalToken;
}

/**
 * One year from today, in the calendar's own terms.
 *
 * `setFullYear` on a copy of today, rather than arithmetic on a day count: a year
 * is not a fixed number of days, and the date the picker wants is the same
 * day-of-month a year on. February 29 rolls forward to 1 March, which is the one
 * case the caller's fallback exists for.
 */
function oneYearFromToday(): Date {
  const target = new Date();
  target.setFullYear(target.getFullYear() + 1);
  return target;
}

/**
 * The token, read out of the page that announces it.
 *
 * **Polled from the page's whole text rather than pulled out of the dialog that
 * shows it.** The token is printed once, in a modal that says so, and reaching
 * into that modal's node is a guess about markup for no gain: what is known is
 * the token's own shape, and a page that has printed it contains it. Polling also
 * covers the gap between Create being clicked and the modal rendering, which is
 * where an extraction that read once failed — reporting a lost token for a token
 * that was about to appear.
 */
async function readPrintedToken(context: FlowContext): Promise<string> {
  const deadline = Date.now() + TOKEN_DIALOG_MS;
  for (;;) {
    const text = await context.page.innerText('body').catch(() => '');
    const match = PAT_PATTERN.exec(text);
    if (match !== null) return match[0];

    if (Date.now() > deadline) {
      throw new Error(
        `qoder created a token but no token appeared on ${context.page.url()}; it is shown once, so this one is lost`,
      );
    }
    await waitFor(
      new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      }),
      context.signal,
      5_000,
      'the token',
    ).catch(() => undefined);
  }
}

/**
 * Spend the PAT on the token a client uses.
 *
 * Failure here is retryable rather than fatal: the exchange is a plain HTTP call
 * to a provider endpoint, and a 5xx or a timeout says nothing about the account.
 * The one thing that is *not* retried is the token — it is shown once, so a lost
 * one means a fresh token, not a second attempt at the same string.
 */
async function exchangePersonalToken(
  context: FlowContext,
  personalToken: string,
): Promise<{ securityOauthToken: string; refreshToken: string }> {
  context.step('exchange the token', 'running');
  let response: Response;
  try {
    response = await fetch(patExchangeUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ personal_token: personalToken }),
    });
  } catch (cause) {
    throw new RetryableError(
      `the qoder token exchange could not be reached: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new RetryableError(
      `the qoder token exchange refused the token (${response.status}): ${body.slice(0, 160)}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    token?: unknown;
    refresh_token?: unknown;
  } | null;
  const token = typeof payload?.token === 'string' ? payload.token : '';
  if (token === '') {
    throw new Error('the qoder token exchange answered without a token');
  }

  context.step('exchange the token', 'ok');
  return {
    securityOauthToken: token,
    refreshToken: typeof payload?.refresh_token === 'string' ? payload.refresh_token : '',
  };
}

/**
 * Who the account is, recorded beside the token.
 *
 * **The chat codec cannot sign a request without these.** qoder's signing carries
 * the account's own id and type inside an encrypted payload, and neither is
 * derivable from the token — a credential that holds only a token cannot be used
 * for anything but quota reads. The identity is asked for here, once, at the
 * moment the account is created, because this is the only point where the flow
 * already has the token in hand and the account is about to be stored.
 *
 * A failure here is not fatal to the import: the account is still worth storing
 * and the codec's own message names the missing field if it is asked to sign
 * without one. What it must not do is invent a value — a wrong id signs a request
 * that qoder rejects with no explanation at all.
 */
async function fetchIdentity(
  securityOauthToken: string,
): Promise<{ userId: string; userType: string }> {
  try {
    const response = await fetch('https://openapi.qoder.sh/api/v2/quota/usage', {
      headers: {
        authorization: `Bearer ${securityOauthToken}`,
        'Cosy-ClientType': '5',
        accept: 'application/json',
      },
    });
    if (!response.ok) return { userId: '', userType: '' };
    const body = (await response.json().catch(() => null)) as {
      userId?: unknown;
      userType?: unknown;
    } | null;
    return {
      userId: typeof body?.userId === 'string' ? body.userId : '',
      userType: typeof body?.userType === 'string' ? body.userType : '',
    };
  } catch {
    return { userId: '', userType: '' };
  }
}
