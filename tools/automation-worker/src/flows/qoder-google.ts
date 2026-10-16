import { RetryableError, type ImportedAccount } from '../driver.ts';
import { driveGoogleSignIn } from './google-signin.ts';
import { asFlowError, clickAny, STEP_TIMEOUT_MS } from './shared.ts';
import { splitCredential, waitFor, type FlowContext, type ProviderFlow } from './types.ts';

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

    // The start URL is qoder's Google entry point, so the hand-off has already
    // happened by the time the walk begins.
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

    return {
      credential: JSON.stringify({ personalToken, ...exchanged, email }),
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

    // Open the calendar and take a day a year out. A token that expires next month
    // is worse than useless for an account an operator is stockpiling, and the
    // year button is what makes the expiry meaningful rather than incidental.
    await page.locator(TOKEN_EXPIRY).first().click();
    const nextYear = page.locator('button[aria-label*="Next year"], .ant-picker-header-super-next-btn');
    if ((await nextYear.count()) > 0) {
      await nextYear.first().click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
    // The last enabled cell in view rather than a particular date: which days a
    // picker disables is the picker's business, and any future day satisfies the
    // form. Choosing by position is what survives that.
    const enabledDays = page.locator(
      '.ant-picker-cell-in-view:not(.ant-picker-cell-disabled) .ant-picker-cell-inner',
    );
    if ((await enabledDays.count()) === 0) {
      throw new Error('qoder’s expiry picker offered no selectable day');
    }
    await enabledDays.last().click();
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
