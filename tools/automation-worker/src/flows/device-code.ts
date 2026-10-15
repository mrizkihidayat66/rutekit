import {
  ItemAbandonedError,
  RetryableError,
  type FrameCapture,
  type ImportedAccount,
} from '../driver.ts';
import { detectChallenge } from './challenge.ts';
import { AbortError, waitFor, type FlowContext, type ProviderFlow } from './types.ts';

/**
 * A device-code sign-in (C7c, FR-5.9).
 *
 * The provider shows a short code on one page and the operator approves it from
 * whatever browser they already have open. The worker's job is to open the page,
 * read the code off it, show it to the operator, and wait for the approval to
 * land — which is a flow the manifest genuinely describes (`login: 'device-code'`,
 * and `authModes` carrying the device and token endpoints), unlike a browser
 * sign-in whose form only the provider's own page knows.
 *
 * **The operator is the point, not a fallback.** A device flow exists so the
 * credential never passes through the client, and the human approving it is the
 * design rather than a step this flow would rather automate. So the code is
 * reported as a step the moment it is read — which is what puts it in the console's
 * timeline where the operator can read it — and the flow then waits.
 *
 * **No shipped provider declares it yet.** The manifest schema allows it, and
 * kiro's own auth mode is a device flow, but every curated `automation` block
 * currently says `login: 'browser'`. This flow is therefore written and tested
 * against a fixture page rather than against a provider, and saying so is the
 * difference between a feature and a claim.
 */

/** How long the page is given to show a code. */
const CODE_TIMEOUT_MS = 30_000;

/**
 * How long the approval is given to land before a human is asked.
 *
 * Long on purpose: the operator has to notice the code, open their browser, and
 * approve it. Two minutes is the ordinary case, and the provider's own allowance
 * (`humanTimeoutSeconds`) is what bounds the wait after this one expires.
 *
 * Overridable because a test that had to wait two minutes to reach the branch
 * that asks would be a test nobody runs — the interval is a policy, not a fact
 * about the page.
 */
function approvalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RUTEKIT_DEVICE_APPROVAL_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 120_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

/** How long the page is given to notice an approval the operator just made. */
const APPROVAL_SETTLE_MS = 15_000;

/**
 * What a device code looks like.
 *
 * The conventional shape is two groups of four to five uppercase alphanumerics
 * with a dash — `ABCD-EFGH`. Providers vary the grouping and some use digits
 * only, so the pattern is the shape rather than the vendor's spelling.
 */
const CODE_PATTERNS: readonly RegExp[] = [
  /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/,
  /\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/,
];

export const deviceCode: ProviderFlow = {
  name: 'device-code',

  supports: (job) => job.automation?.login === 'device-code' && job.method === 'bulk-login',

  async importItem(context: FlowContext): Promise<ImportedAccount> {
    const { page, job, item, signal, step } = context;
    const automation = job.automation;
    if (automation === null) {
      throw new Error(`${job.providerId} declares no automation flow`);
    }

    step('open', 'running');
    try {
      await waitFor(page.goto(automation.startUrl), signal, CODE_TIMEOUT_MS, 'the start page');
    } catch (cause) {
      throw asFlowError(cause, 'open', 'the start page did not load');
    }
    step('open', 'ok', page.url());

    await parkIfChallenged(context);

    step('read the code', 'running');
    const code = await waitForCode(context);
    if (code === null) {
      throw new RetryableError(
        `${job.providerId} showed no device code at ${page.url()}`,
      );
    }
    // The step detail is how the code reaches the operator: the console's
    // timeline renders it, and the preview shows the page it came from.
    step('read the code', 'ok', `approve ${code} in your own browser`);
    const codeFrame = await captureFrame(context);
    if (codeFrame !== null) context.screenshot(codeFrame);

    step('wait for approval', 'running');
    const approved = await waitForApproval(context);
    if (!approved) {
      // Nobody approved it in time. The code is expired or about to be, so the
      // honest move is a fresh attempt rather than holding the page open.
      throw new RetryableError(
        `the device code for ${job.providerId} was not approved in time`,
      );
    }
    step('wait for approval', 'ok');

    step('collect', 'running');
    const credential = await collectCredential(context);
    if (credential === null) {
      throw new Error(
        `${job.providerId} approved the code but no credential could be read from ${page.url()}`,
      );
    }
    step('collect', 'ok');

    return { credential, label: item.label };
  },
};

/**
 * The code, from the page's own text.
 *
 * Read from the rendered text rather than from a named element: a device page
 * labels the code differently in every provider's own language, and the shape of
 * the code itself is the one thing that does not change.
 */
async function waitForCode(context: FlowContext): Promise<string | null> {
  const deadline = Date.now() + CODE_TIMEOUT_MS;
  for (;;) {
    const text = await bodyText(context);
    for (const pattern of CODE_PATTERNS) {
      const match = pattern.exec(text);
      if (match !== null) return match[0];
    }
    if (Date.now() > deadline) return null;
    // A device page may render the code after a round trip, so this polls rather
    // than reading once — and it is a poll the signal can cut short.
    await waitFor(sleep(500), context.signal, 1_000, 'the code').catch(() => undefined);
    if (context.signal.aborted) return null;
  }
}

/**
 * Whether the approval landed.
 *
 * Detected by the page leaving the code page, which is what every device page
 * does on success and is the only signal that does not require knowing the
 * provider's markup. When it does not land within the window, the operator is
 * asked — the deadline is theirs to spend.
 */
async function waitForApproval(context: FlowContext): Promise<boolean> {
  const startedAt = context.page.url();
  const window = approvalTimeoutMs();
  try {
    await waitFor(
      context.page.waitForURL((url) => url.toString() !== startedAt, { timeout: window }),
      context.signal,
      window + 1_000,
      'the approval',
    );
    return true;
  } catch (cause) {
    if (cause instanceof AbortError) throw new ItemAbandonedError(cause.message);

    // Not approved. Rather than spending the item's retries on a code nobody
    // looked at, the operator gets the chance to approve it now — in their own
    // browser, which is where a device flow is approved.
    const frame = await captureFrame(context);
    const answer = await context.askManual(
      'the device code was not approved in time — approve it and answer "done"',
      frame?.frameUrl ?? null,
    );
    if (answer.trim() === '') return false;

    // The operator said it is done, so the page should move. Waited for rather
    // than assumed: their approval travels through the provider's own service, and
    // the page learns about it a moment after they click. A timeout is not a
    // failure — the collect step is what says whether a credential arrived.
    await waitFor(
      context.page.waitForURL((url) => url.toString() !== startedAt, {
        timeout: APPROVAL_SETTLE_MS,
      }),
      context.signal,
      APPROVAL_SETTLE_MS + 1_000,
      'the page after the approval',
    ).catch(() => undefined);
    return true;
  }
}

async function parkIfChallenged(context: FlowContext): Promise<void> {
  const verdict = detectChallenge(await bodyText(context));
  if (!verdict.detected) return;

  context.step('challenge', 'running', `the page says "${verdict.marker ?? ''}"`);
  const frame = await captureFrame(context);
  // The operator solves it in the live browser through a manual session (FR-5.7)
  // and answers to say so — this flow has nothing to type on their behalf.
  const answer = await context.askManual(
    `challenge: ${verdict.marker ?? 'unknown'}`,
    frame?.frameUrl ?? null,
  );
  context.step('challenge', 'ok', `the operator answered "${answer}"`);
}

async function bodyText(context: FlowContext): Promise<string> {
  try {
    return await context.page.innerText('body');
  } catch {
    return '';
  }
}

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
 * The credential the approved page exposes.
 *
 * A device flow usually ends on a page that hands over a token, or writes it
 * somewhere the provider's own client reads. The field first, then the page's
 * text — the same order the browser flow uses, and for the same reason. The walk
 * is done with `inputValue()` rather than a page-side `evaluate`, which is what
 * keeps this file free of DOM types.
 */
async function collectCredential(context: FlowContext): Promise<string | null> {
  const fields = context.page.locator('input, textarea');
  const count = Math.min(await fields.count(), 50);

  for (let index = 0; index < count; index += 1) {
    const value = (await fields.nth(index).inputValue().catch(() => '')).trim();
    if (value.length >= 20) return value;
  }

  const match = /\b(?:sk|rk|pk|gsk|xai|api)[-_][A-Za-z0-9_-]{16,}\b/.exec(await bodyText(context));
  return match === null ? null : match[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asFlowError(cause: unknown, step: string, fallback: string): Error {
  if (cause instanceof AbortError) return new ItemAbandonedError(cause.message);
  return new RetryableError(`${step}: ${cause instanceof Error ? cause.message : fallback}`);
}
