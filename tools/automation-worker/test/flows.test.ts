import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerItem, WorkerJob } from '@rutekit/contracts';

import { createPlaywrightDriver } from '../src/drivers/playwright.ts';
import { ItemAbandonedError, type FrameCapture, type StepStatus } from '../src/driver.ts';
import { resolveFlow, REGISTERED_PROVIDERS } from '../src/flows/index.ts';

/**
 * The flows, against a real browser (C7c).
 *
 * The other suites test what can be tested without one. This one drives Chromium
 * — the actual engine the worker ships — against pages served from a local
 * fixture server, which is the only way to prove that the selectors, the waits
 * and the collection actually work. A flow tested against a mock `Page` would
 * pass while the real one failed on the first navigation.
 *
 * **The pages are fixtures, not providers.** No provider's markup is reproduced
 * here, because none of it has been seen: the fixtures are the shapes the flows
 * claim to handle — a two-field sign-in, a key page, a challenge page, a device
 * page — and the flows are held to those. That is the honest scope of the claim:
 * the machinery works against the shapes it says it works against, and a provider
 * whose page is a different shape will fail with a step name saying which part
 * was missing.
 *
 * Chromium is already on this machine (the worker's own dependency), so this is
 * not a test that needs a download.
 */

let server: Server;
let base: string;

/** The pages the fixtures serve, keyed by path. */
const PAGES: Record<string, string> = {
  '/signin': `<!doctype html><html><body>
    <h1>Sign in</h1>
    <form id="f">
      <input type="email" name="email" />
      <input type="password" name="password" />
      <button type="submit">Sign in</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', (event) => {
        event.preventDefault();
        location.href = '/keys';
      });
    </script>
  </body></html>`,

  '/keys': `<!doctype html><html><body>
    <h1>Your API key</h1>
    <input readonly value="sk-proj-abcdefghijklmnopqrstuvwxyz1234" />
  </body></html>`,

  // A sign-in form whose fields are not typed, which is the case the fallback
  // selector exists for.
  '/signin-plain': `<!doctype html><html><body>
    <form id="f">
      <input name="login" />
      <input type="password" name="pass" />
      <button type="submit">Log in</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', (event) => {
        event.preventDefault();
        location.href = '/keys';
      });
    </script>
  </body></html>`,

  // A sign-in that lands on a challenge. The real sequence: the form is
  // submitted, the provider decides a human is needed, and the page that follows
  // is the one that says so.
  '/signin-guarded': `<!doctype html><html><body>
    <h1>Sign in</h1>
    <form id="f">
      <input type="email" name="email" />
      <input type="password" name="password" />
      <button type="submit">Sign in</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', (event) => {
        event.preventDefault();
        location.href = '/challenge';
      });
    </script>
  </body></html>`,

  // The challenge itself. It clears two ways, and both are real: a solved captcha
  // is submitted and the page moves on, and an operator who solved it in the live
  // browser finds the page already moving. The auto-clear covers the second.
  '/challenge': `<!doctype html><html><body>
    <h1>Verify your identity</h1>
    <p>We noticed unusual activity. Please complete the CAPTCHA.</p>
    <form id="f">
      <input name="captcha" />
      <button type="submit">Continue</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', (event) => {
        event.preventDefault();
        location.href = '/keys';
      });
      setTimeout(() => { location.href = '/keys'; }, 1500);
    </script>
  </body></html>`,

  // A page with no password field at all: the case the flow must refuse rather
  // than fill something else in.
  '/no-form': `<!doctype html><html><body><h1>Nothing to sign in with</h1></body></html>`,

  // A device page that gets approved: the code is shown, and the approval lands
  // on its own, which is what the operator clicking approve in their own browser
  // looks like from here.
  '/device': `<!doctype html><html><body>
    <h1>Device authorization</h1>
    <p>Enter the code <strong>ABCD-EFGH</strong> to continue.</p>
    <script>
      setTimeout(() => { location.href = '/keys'; }, 600);
    </script>
  </body></html>`,

  // A device page whose approval arrives late — after the flow's own window has
  // closed, so the operator is asked, and then it lands. That is the sequence
  // FR-5.5 describes: the code is not approved in time, a human is asked, and the
  // job carries on rather than failing.
  '/device-slow': `<!doctype html><html><body>
    <h1>Device authorization</h1>
    <p>Enter the code <strong>WXYZ-1234</strong> to continue.</p>
    <script>
      setTimeout(() => { location.href = '/keys'; }, 800);
    </script>
  </body></html>`,
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const page = PAGES[path];
    if (page === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${String(address.port)}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

function item(credential: string): WorkerItem {
  return { id: 'i1', label: 'a***@example.com', credential };
}

function jobFor(path: string, overrides: Partial<WorkerJob> = {}): WorkerJob {
  return {
    jobId: 'j1',
    providerId: 'kiro',
    method: 'bulk-login',
    engine: 'chromium',
    mode: 'headless',
    concurrency: 1,
    maxAttempts: 3,
    automation: {
      login: 'browser',
      startUrl: `${base}${path}`,
      captcha: true,
      humanTimeoutSeconds: 180,
    },
    proxy: null,
    sms: null,
    items: [item('alice@example.com:pw1')],
    ...overrides,
  };
}

/** What a flow reported while it ran. */
interface Recorded {
  readonly steps: { name: string; status: StepStatus; detail: string | null }[];
  readonly frames: FrameCapture[];
  readonly manualAsks: { reason: string; screenshotUrl: string | null }[];
}

/**
 * The step names in order, with each step counted once.
 *
 * A step is reported twice — `running` and then its outcome — so the raw list has
 * every name twice. The shape of a flow is the sequence of names, which is what
 * this returns.
 */
function namesOf(recorded: Recorded): string[] {
  const names: string[] = [];
  for (const step of recorded.steps) {
    if (step.status === 'running') names.push(step.name);
  }
  return names;
}

/**
 * Run one item through the real driver, with the answers a test chooses.
 *
 * The driver is the shipped one; only the flow's answers to `askManual` and the
 * solver are scripted, because those are the two things that would otherwise need
 * a person or a paid service.
 */
async function runFlow(
  job: WorkerJob,
  options: {
    readonly manualAnswer?: string;
    readonly solverAnswer?: string | null;
  } = {},
): Promise<{ recorded: Recorded; account: { credential: string; label: string } }> {
  const recorded: Recorded = { steps: [], frames: [], manualAsks: [] };
  const resolved = resolveFlow(job);
  const driver = createPlaywrightDriver({
    flow: resolved.flow,
    ...(resolved.reason === null ? {} : { noFlowReason: resolved.reason }),
    previewIntervalMs: 100_000,
    ...(options.solverAnswer === undefined
      ? {}
      : { solver: { name: 'test', solve: () => Promise.resolve(options.solverAnswer ?? null) } }),
  });

  const controller = new AbortController();
  try {
    const account = await driver.importItem({
      job,
      item: job.items[0] as WorkerItem,
      signal: controller.signal,
      step: (name, status, detail = null) => {
        recorded.steps.push({ name, status, detail });
      },
      screenshot: (frame) => {
        recorded.frames.push(frame);
      },
      askManual: (reason, screenshotUrl) => {
        recorded.manualAsks.push({ reason, screenshotUrl });
        if (options.manualAnswer === undefined) {
          controller.abort();
          return Promise.reject(new ItemAbandonedError('the deadline passed'));
        }
        return Promise.resolve(options.manualAnswer);
      },
    });
    return { recorded, account };
  } finally {
    await driver.close();
  }
}

describe('the generic sign-in flow', () => {
  it('signs in and reads the key off the page after', async () => {
    const { account, recorded } = await runFlow(jobFor('/signin'));

    // The credential the flow collected is the one the fixture's key page shows.
    expect(account.credential).toBe('sk-proj-abcdefghijklmnopqrstuvwxyz1234');
    expect(account.label).toBe('a***@example.com');

    // Every step is reported twice — `running` then its outcome — which is what
    // the console's timeline draws. The names, in order, are the flow's shape.
    expect(namesOf(recorded)).toEqual([
      'open',
      'find the form',
      'sign in',
      'wait for the dashboard',
      'collect',
    ]);
    expect(recorded.steps.filter((step) => step.status === 'running')).toHaveLength(5);
    expect(recorded.steps.filter((step) => step.status === 'ok')).toHaveLength(5);
  });

  it('finds an untyped sign-in form, which is what the fallback selector is for', async () => {
    const { account } = await runFlow(jobFor('/signin-plain'));
    expect(account.credential).toContain('sk-proj-');
  });

  it('refuses a page with no password field, and says which step', async () => {
    // Not a retryable failure: the page is what it is, and another attempt finds
    // the same page. The message names the provider and the URL so an operator can
    // look at what was served.
    await expect(runFlow(jobFor('/no-form'))).rejects.toThrow(/no password field/u);
  }, 40_000);

  it('refuses an item that is not an email and a password', async () => {
    const job = jobFor('/signin');
    const withToken = { ...job, items: [item('just-a-token')] };
    await expect(runFlow(withToken)).rejects.toThrow(/needs `email:password`/u);
  });
});

describe('a challenge in the way', () => {
  /** A sign-in that lands on a challenge rather than on the key page. */
  const guardedJob = (): WorkerJob => jobFor('/signin-guarded');

  it('parks the item and carries on with the operator’s answer', async () => {
    const { account, recorded } = await runFlow(guardedJob(), { manualAnswer: 'done' });

    const ask = recorded.manualAsks[0];
    expect(ask).toBeDefined();
    // The card says what the page said, so the operator knows what to look for.
    expect(ask?.reason).toContain('captcha');
    // And it carries the frame, so they can see it.
    expect(ask?.screenshotUrl).toContain('data:image/jpeg');

    // The challenge was reported, answered, and the sign-in then completed —
    // which is the whole FR-5.4/5.5 handshake working end to end.
    expect(namesOf(recorded)).toContain('challenge');
    expect(account.credential).toContain('sk-proj-');
  }, 90_000);

  it('solves it automatically when a solver is configured', async () => {
    const { recorded, account } = await runFlow(guardedJob(), { solverAnswer: 'AB12C' });

    // Nobody was interrupted, which is the whole reason a solver is worth having.
    expect(recorded.manualAsks).toEqual([]);
    expect(recorded.steps.some((step) => step.detail === 'solved automatically')).toBe(true);
    expect(account.credential).toContain('sk-proj-');
  }, 90_000);

  it('falls back to a human when the solver could not read it', async () => {
    const { recorded } = await runFlow(guardedJob(), {
      solverAnswer: null,
      manualAnswer: 'done',
    });

    // A solver that returns nothing is a solver that did not help, and the item
    // parks exactly as it would have without one.
    expect(recorded.manualAsks).toHaveLength(1);
  }, 90_000);

  it('abandons the item when nobody answers', async () => {
    // No `manualAnswer`, so the test's `askManual` aborts — which is what the
    // host's deadline does.
    await expect(runFlow(guardedJob())).rejects.toThrow(ItemAbandonedError);
  }, 90_000);
});

describe('the device-code flow', () => {
  const deviceJob = (path = '/device'): WorkerJob =>
    jobFor(path, {
      providerId: 'device-fixture',
      automation: {
        login: 'device-code',
        startUrl: `${base}${path}`,
        captcha: true,
        humanTimeoutSeconds: 180,
      },
    });

  it('reads the code off the page and reports it to the operator', async () => {
    const { account, recorded } = await runFlow(deviceJob(), { manualAnswer: 'done' });

    const read = recorded.steps.find(
      (step) => step.name === 'read the code' && step.status === 'ok',
    );
    // The code reaches the operator through the step detail, which is what the
    // console's timeline renders.
    expect(read?.detail).toContain('ABCD-EFGH');
    expect(account.credential).toContain('sk-proj-');
  }, 90_000);

  it('asks the operator when the approval did not land in time', async () => {
    // The approval window is closed to a moment, so the branch that asks is
    // reachable without waiting out the two minutes a real operator gets.
    process.env['RUTEKIT_DEVICE_APPROVAL_TIMEOUT_MS'] = '200';
    try {
      const { account, recorded } = await runFlow(deviceJob('/device-slow'), {
        manualAnswer: 'done',
      });

      const read = recorded.steps.find(
        (step) => step.name === 'read the code' && step.status === 'ok',
      );
      expect(read?.detail).toContain('WXYZ-1234');

      // Nobody had approved it by the time the flow's own window closed, so
      // rather than spending the item's retries on a code nobody looked at, the
      // operator got the chance to approve it — and the job carried on.
      expect(recorded.manualAsks).toHaveLength(1);
      expect(recorded.manualAsks[0]?.reason).toContain('not approved');
      expect(account.credential).toContain('sk-proj-');
    } finally {
      delete process.env['RUTEKIT_DEVICE_APPROVAL_TIMEOUT_MS'];
    }
  }, 90_000);
});

describe('resolving a flow', () => {
  it('has an entry for every provider the frontend offers', () => {
    // The four the launcher's own vocabulary lists. A provider added to the UI
    // without a flow here would fail at the first item rather than at the start.
    for (const providerId of ['kiro', 'qoder', 'codebuddy-intl', 'codebuddy-cn']) {
      expect(REGISTERED_PROVIDERS, providerId).toContain(providerId);
    }
  });

  it('answers nothing for a provider nobody has written a flow for', () => {
    const resolved = resolveFlow(jobFor('/signin', { providerId: 'someone-else' }));

    expect(resolved.flow).toBeNull();
    // The message names the provider, which is what tells an operator what to do.
    expect(resolved.reason).toContain('someone-else');
  });

  it('uses the device flow when the manifest asked for it', () => {
    const resolved = resolveFlow(
      jobFor('/device', {
        providerId: 'unregistered-but-declared',
        automation: {
          login: 'device-code',
          startUrl: `${base}/device`,
          captcha: false,
          humanTimeoutSeconds: 60,
        },
      }),
    );

    // Not a fallback: the manifest declared the login mode, so this is reading the
    // source of truth rather than inferring from it (ADR-0018).
    expect(resolved.flow?.name).toBe('device-code');
  });

  it('refuses a token import, which opens no browser', () => {
    const resolved = resolveFlow(jobFor('/signin', { method: 'bulk-token' }));

    expect(resolved.flow).toBeNull();
    expect(resolved.reason).toContain('bulk-token');
  });
});
