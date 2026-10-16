import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RetryableError, type ImportedAccount } from '../driver.ts';
import { driveGoogleSignIn } from './google-signin.ts';
import { asFlowError, STEP_TIMEOUT_MS } from './shared.ts';
import { splitCredential, waitFor, type FlowContext, type ProviderFlow } from './types.ts';

/**
 * Kiro's sign-in, which is an OAuth authorization code taken through Google (C7c).
 *
 * **Kiro exposes no credential to a browser session, and this is the flow that
 * stops pretending otherwise.** Signing in works — Google, then `app.kiro.dev/home`
 * — and every settings page behind it was walked: no input anywhere, no key, just
 * a name, a plan and a usage figure. What kiro actually issues is an **OAuth token
 * pair**, and it issues it to a client that asks in the right way:
 *
 *   1. a **PKCE** pair is generated locally, so the code that comes back is worth
 *      nothing to anyone who intercepts it;
 *   2. the browser is sent to kiro's desktop sign-in with `idp=Google`, the
 *      challenge, and a redirect to a **custom scheme** — `kiro://…`, which is
 *      where kiro's own desktop app catches it and which a browser cannot open;
 *   3. Google's sign-in runs inside that page, unchanged;
 *   4. the redirect to `kiro://` is intercepted before the browser can fail on it,
 *      and the `code` is read out of the URL;
 *   5. the code and the verifier are exchanged at kiro's token endpoint for the
 *      pair that is the account.
 *
 * **The interception is the trick, and it is not a workaround.** The custom scheme
 * is how kiro hands a credential to its desktop app, so a flow that let the
 * navigation happen would watch the browser fail to open an app it does not have.
 * Aborting it and reading the URL is exactly what the app does with it.
 *
 * **The credential is the token JSON**, stored as one blob: `accessToken`,
 * `refreshToken`, and `profileArn` — the last one because kiro's own usage
 * endpoint needs it, and a token without it cannot be asked what it is worth.
 *
 * **This replaces a flow that signed in and then failed.** The previous version
 * walked kiro's own sign-in page, completed the Google hand-off, landed on
 * `/home`, and reported "no credential could be read" — which was true, and was
 * the finding: there is no credential on that page to read. The walk itself was
 * never the problem, so it is still here; what changed is that the browser now
 * starts at kiro's *authorization* endpoint rather than at its marketing sign-in,
 * and finishes by exchanging a code instead of scanning a page.
 */

/**
 * Where kiro's own app catches the code.
 *
 * A custom scheme on purpose: the code must reach the client without passing
 * through a web origin, and this flow stands in for the client.
 */
const REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success';

/** How long the whole authorization is given. */
const AUTHORIZE_TIMEOUT_MS = 180_000;

export const kiroGoogle: ProviderFlow = {
  name: 'kiro-google',

  supports: (job) =>
    job.providerId === 'kiro' &&
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

    const { verifier, challenge } = pkcePair();

    /**
     * The code, read off the custom-scheme navigation kiro sends it in.
     *
     * **A request listener rather than a route, and finding that out took a
     * failing run.** Playwright's route matching covers HTTP requests; a `kiro://`
     * navigation is not one, so a route handler never sees it — the request event
     * fires, the handler does not, and the flow waits for a code that has already
     * gone past. Nothing needs aborting either: the browser cannot follow a scheme
     * no application is registered for, so the navigation fails harmlessly and the
     * page stays where it was, which is what this flow wants.
     */
    let captured: string | null = null;
    const onRequest = (request: { url: () => string }): void => {
      const target = request.url();
      if (!target.startsWith('kiro://')) return;
      const code = readCode(target);
      if (code !== null && captured === null) captured = code;
    };
    page.on('request', onRequest);

    // The manifest names kiro's authorization endpoint; the PKCE values are this
    // attempt's, so they are added here rather than stored (ADR-0018).
    const authorizeUrl = new URL(automation.startUrl);
    authorizeUrl.searchParams.set('idp', 'Google');
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', randomUUID());
    const tokenUrl = `${authorizeUrl.origin}/oauth/token`;

    step('open', 'running');
    try {
      await waitFor(page.goto(authorizeUrl.toString()), signal, STEP_TIMEOUT_MS, 'the authorization page');
    } catch (cause) {
      throw asFlowError(cause, 'open', 'the authorization page did not load');
    }
    step('open', 'ok', page.url());

    // `isDone` because the code arrives without the browser ever leaving Google:
    // the consent screen's redirect is aborted by the handler above, so the page
    // stays put and the walk has to be told it succeeded.
    await driveGoogleSignIn(context, {
      email,
      password,
      isDone: () => captured !== null,
    });

    step('read the authorization code', 'running');
    const code = await waitForCode(context, () => captured);
    step('read the authorization code', 'ok');

    const tokens = await exchangeCode(context, tokenUrl, code, verifier);

    return {
      credential: JSON.stringify({ ...tokens, email }),
      label: item.label,
    };
  },
};

/**
 * A PKCE pair.
 *
 * The verifier is 32 random bytes in base64url, which is the shape RFC 7636 asks
 * for; the challenge is its SHA-256, in the same alphabet and unpadded, because
 * the endpoint compares the two strings rather than the bytes behind them.
 */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** The `code` out of a `kiro://` callback URL, or null when it is not one yet. */
function readCode(url: string): string | null {
  try {
    return new URL(url).searchParams.get('code');
  } catch {
    return null;
  }
}

/**
 * Wait for the redirect the browser is not allowed to follow.
 *
 * Polled rather than awaited as an event, because the handler that catches it runs
 * outside this flow's control and there is no promise to hold: the loop is the
 * honest way to wait for something another part of the page decides.
 */
async function waitForCode(
  context: FlowContext,
  current: () => string | null,
): Promise<string> {
  const deadline = Date.now() + AUTHORIZE_TIMEOUT_MS;
  for (;;) {
    const code = current();
    if (code !== null) return code;

    if (Date.now() > deadline) {
      throw new RetryableError(
        `kiro never returned an authorization code; the browser is at ${context.page.url()}`,
      );
    }
    await waitFor(
      new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      }),
      context.signal,
      5_000,
      'the authorization code',
    ).catch(() => undefined);
  }
}

/**
 * Spend the code on the token pair that is the account.
 *
 * Retryable on a transport failure and on a 5xx — those say nothing about the
 * account — but a 4xx is final: a code the endpoint rejects is a code this attempt
 * cannot make good, and the next one starts from a fresh authorization.
 */
async function exchangeCode(
  context: FlowContext,
  tokenUrl: string,
  code: string,
  verifier: string,
): Promise<{ accessToken: string; refreshToken: string; profileArn: string }> {
  context.step('exchange the code', 'running');

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: REDIRECT_URI }),
    });
  } catch (cause) {
    throw new RetryableError(
      `kiro's token endpoint could not be reached: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }

  if (response.status >= 500 || response.status === 429) {
    throw new RetryableError(`kiro's token endpoint failed (${response.status})`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `kiro's token endpoint rejected the authorization (${response.status}): ${body.slice(0, 160)}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const accessToken = typeof payload?.['accessToken'] === 'string' ? payload['accessToken'] : '';
  if (accessToken === '') {
    throw new Error("kiro's token endpoint answered without an access token");
  }

  context.step('exchange the code', 'ok');
  return {
    accessToken,
    refreshToken: typeof payload?.['refreshToken'] === 'string' ? payload['refreshToken'] : '',
    profileArn: typeof payload?.['profileArn'] === 'string' ? payload['profileArn'] : '',
  };
}
