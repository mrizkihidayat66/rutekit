import type { Browser } from 'playwright';
import type { BrowserEngine, JobMode } from '@rutekit/contracts';

/**
 * Launching the browser a job asked for (C7c, FR-5.9).
 *
 * Two engines, and they are genuinely different things rather than two settings
 * of one: Chromium is the default — fast to start and what most provider pages
 * are built for — and Camoufox is a hardened Firefox build that presents as an
 * ordinary browser, for the pages that decide a plain Chromium is not one.
 *
 * **Both are imported lazily.** A job that never reaches a browser — a token
 * import, or a test on the fake driver — should not pay to load either, and
 * `camoufox-js` in particular pulls in a great deal that a token import has no
 * use for.
 *
 * **The mode is separate from the engine.** `headed` draws a window; the default
 * is headless, which is what an unattended batch wants. Camoufox has a third
 * option of its own (`virtual`), and it is deliberately not exposed: rutekit's
 * contract has two modes, and inventing a third here would put a value in the
 * console's picker that no job could have chosen.
 */

export interface EngineOptions {
  readonly engine: BrowserEngine;
  readonly mode: JobMode | null;
  /** The egress, resolved by the host, or null to leave directly. */
  readonly proxyUrl: string | null;
}

/** A launched browser, and the name of the engine that is actually running. */
export interface LaunchedEngine {
  readonly browser: Browser;
  /** What ran. Not always what was asked for — see `launchEngine`. */
  readonly name: string;
}

export async function launchEngine(options: EngineOptions): Promise<LaunchedEngine> {
  const headless = options.mode !== 'headed';

  if (options.engine === 'camoufox') {
    const { Camoufox } = await import('camoufox-js');
    // Camoufox takes its own launch options and a `proxy` that is the same shape
    // Playwright's is, so the egress travels the same way for both engines.
    const browser = await Camoufox({
      headless,
      ...(options.proxyUrl === null ? {} : { proxy: options.proxyUrl }),
    });
    // Camoufox hands back a `playwright-core` browser, which is the same shape
    // Playwright's own is — the two packages describe the same object.
    return { browser, name: 'camoufox' };
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless,
    ...(options.proxyUrl === null ? {} : { proxy: { server: options.proxyUrl } }),
  });
  return { browser, name: 'chromium' };
}

/**
 * Whether an engine can be launched at all.
 *
 * Camoufox needs a Firefox build fetched onto the machine, and a machine that has
 * not done that fails at launch with an install prompt rather than a job error.
 * Asking first means the failure is a sentence naming the engine and the command,
 * which is something an operator can act on — and it is checked at job start
 * rather than at the first item, so a misconfigured engine costs one message
 * instead of a batch.
 */
export async function engineAvailable(engine: BrowserEngine): Promise<string | null> {
  if (engine === 'chromium') {
    // Playwright ships its own check; a missing Chromium is reported by the
    // launch, and its message already names the command that fixes it.
    return null;
  }
  try {
    const { Camoufox } = await import('camoufox-js');
    // The module loads, but the browser build may not be on disk. Camoufox's own
    // `CamoufoxFetcher` is what knows; calling it would download, so the check is
    // structural: the import resolving is as much as this can prove without
    // spending a download.
    void Camoufox;
    return null;
  } catch (cause) {
    return `the camoufox engine could not be loaded (${describe(cause)}); run \`bunx camoufox-js fetch\``;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'unknown error';
}
