import type { Browser, BrowserContext, Page } from 'playwright';

import { noCaptchaSolver, type CaptchaSolver } from '../captcha.ts';
import {
  type BrowserDriver,
  type FrameCapture,
  type ImportContext,
  type ImportedAccount,
} from '../driver.ts';
import { engineAvailable, launchEngine } from '../engine.ts';
import type { ProviderFlow } from '../flows/types.ts';

/**
 * The browser driver (C7c, ADR-0009).
 *
 * This is the mechanical half and nothing else: launch the engine the job asked
 * for, give each item its own browser context, run the preview clock, hand the
 * page to the provider's flow, and close everything however it ended. **What it
 * does not contain is any provider's flow** — that lives in `flows/`, one file
 * per kind of sign-in, because a driver that knew every provider's markup would
 * change whenever any provider's page did.
 *
 * **One browser, one context per item.** A Chromium launch is the expensive part
 * and a context is how Playwright isolates a session, so concurrency is N
 * contexts inside one process rather than N processes. That is what makes "one
 * worker per job" affordable (ADR-0025).
 *
 * **The proxy is on the browser, not on each context.** A job names one egress,
 * so every item in it leaves through the same one — which is the point, since the
 * same sign-in attempted from one address a hundred times is the pattern a
 * provider blocks. C7b applied it per context; that was written before there was
 * a flow to think about, and one proxy per job makes the browser the right place.
 * A future job that wants to rotate per item would move it back down.
 *
 * **The engine is checked before the batch starts.** Camoufox needs a Firefox
 * build fetched onto the machine, and a machine that has not done that fails at
 * launch with an install prompt rather than a job error. Asking first turns that
 * into one sentence naming the command to run, instead of a batch that fails
 * item by item.
 */

export interface PlaywrightDriverOptions {
  /**
   * The provider's flow, or null when this provider has none.
   *
   * Resolved by the caller from `flows/`, so the driver never learns which
   * provider it is driving.
   */
  readonly flow: ProviderFlow | null;
  /** Why there is no flow, for the failure message. */
  readonly noFlowReason?: string;
  /** The captcha solver, or the null one when no key is configured. */
  readonly solver?: CaptchaSolver;
  /** How long one navigation may take before it is a retryable failure. */
  readonly navigationTimeoutMs?: number;
  /** How often a preview frame is taken while the flow runs (FR-5.2). */
  readonly previewIntervalMs?: number;
  /**
   * Installed on each item's context before the flow runs.
   *
   * A hook rather than a fixed option because what a caller wants to do to a
   * context is open-ended — permissions, an extra header, a locale — and because
   * a flow whose sign-in leaves the provider's own site (kiro's and qoder's both
   * go through Google) is otherwise untestable: the flow's own logic turns on
   * which host it is on, and a fixture server can only be one host. Serving the
   * third-party host from here is what lets that logic run against real hostnames
   * without a real network.
   */
  readonly configureContext?: (context: BrowserContext) => Promise<void>;
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_PREVIEW_INTERVAL_MS = 2_000;

export function createPlaywrightDriver(options: PlaywrightDriverOptions): BrowserDriver {
  const solver = options.solver ?? noCaptchaSolver;
  let browser: Browser | null = null;

  return {
    name: 'playwright',

    async importItem(context: ImportContext): Promise<ImportedAccount> {
      const flow = options.flow;
      if (flow === null) {
        // Honest rather than silent: a driver that navigated to the start page and
        // reported success would be lying about having imported anything.
        throw new Error(options.noFlowReason ?? `no sign-in flow is defined for ${context.job.providerId} yet`);
      }

      const launched = await ensureBrowser(context);
      const browserContext = await launched.newContext({});
      await options.configureContext?.(browserContext);

      const page = await browserContext.newPage();
      page.setDefaultNavigationTimeout(
        options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
      );

      const preview = startPreview(
        page,
        context,
        options.previewIntervalMs ?? DEFAULT_PREVIEW_INTERVAL_MS,
      );

      try {
        return await flow.importItem({
          page,
          job: context.job,
          item: context.item,
          signal: context.signal,
          step: (name, status, detail = null) => {
            context.step(name, status, detail);
          },
          screenshot: (frame: FrameCapture) => {
            context.screenshot(frame);
          },
          askManual: (reason, screenshotUrl) => context.askManual(reason, screenshotUrl),
          solveCaptcha: (image) => solver.solve(image),
        });
      } finally {
        clearInterval(preview);
        // The context goes whatever happened: a page left open holds a socket, and
        // a batch of two hundred would hold two hundred.
        await browserContext.close().catch(() => undefined);
      }
    },

    async close(): Promise<void> {
      const running = browser;
      browser = null;
      await running?.close().catch(() => undefined);
    },
  };

  /**
   * The browser, launched once and reused by every item.
   *
   * Launching per item would be correct and much slower — a Chromium launch is
   * seconds, and a two-hundred-item batch would spend most of its time starting
   * browsers. Contexts are the isolation boundary; the browser is the resource.
   */
  async function ensureBrowser(context: ImportContext): Promise<Browser> {
    if (browser !== null) return browser;

    const unavailable = await engineAvailable(context.job.engine ?? 'chromium');
    if (unavailable !== null) {
      // Job-level, not item-level: every item would fail the same way, and the
      // message names the command that fixes it.
      throw new Error(unavailable);
    }

    const launched = await launchEngine({
      engine: context.job.engine ?? 'chromium',
      mode: context.job.mode,
      proxyUrl: context.job.proxy?.url ?? null,
    });
    browser = launched.browser;
    return browser;
  }
}

/**
 * A periodic frame for the live preview (FR-5.2).
 *
 * Separate from the frames a flow offers deliberately: a flow pushes a frame when
 * something worth looking at happens — a challenge, a code — and this pushes one
 * on a clock, so the pane is never a still image while a browser is working. The
 * two arrive on the same channel and the console draws the latest.
 */
function startPreview(page: Page, context: ImportContext, intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const jpeg = await page.screenshot({ type: 'jpeg', quality: 60 });
        const size = page.viewportSize();
        context.screenshot({
          frameUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
          width: size?.width ?? 1280,
          height: size?.height ?? 720,
        });
      } catch {
        // A screenshot of a page that is navigating or already closed is not a
        // failure of the job; the next tick will either work or the flow will.
      }
    })();
  }, intervalMs);
  return timer;
}
