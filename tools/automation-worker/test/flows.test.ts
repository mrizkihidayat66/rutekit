import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
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
 * **Two hosts are served differently, and that is the point.** kiro's and qoder's
 * flows both leave the provider's site for Google and decide what to do by which
 * host they are on, so their fixtures live in `HOSTED` and are fulfilled through
 * the browser's own routing under the real hostnames — see `installHostRoutes`.
 * The rest stay on the fixture server, where a path is enough.
 *
 * Chromium is already on this machine (the worker's own dependency), so this is
 * not a test that needs a download.
 */

let server: Server;
let base: string;

/**
 * Fills in what a fixture cannot know on its own.
 *
 * `__TARGET_DAY__` is the day-of-month one year from today — the date qoder's
 * expiry is supposed to carry, computed here the way the flow computes it so the
 * fixture can hold the flow to it.
 */
function render(page: string): string {
  const target = new Date();
  target.setFullYear(target.getFullYear() + 1);
  return page
    .replaceAll('__BASE__', base)
    .replaceAll('__TARGET_DAY__', String(target.getDate()));
}

function serve(
  request: IncomingMessage,
  response: ServerResponse,
  pages: Record<string, string>,
): void {
  const path = (request.url ?? '/').split('?')[0] ?? '/';
  const page = pages[path];
  if (page === undefined) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(render(page));
}

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

  // kiro's authorization endpoint, which is where the flow starts.
  //
  // It stands in for the real one in the two ways that matter to the flow: it
  // refuses a request without a PKCE challenge, and it finishes by redirecting to
  // the **custom scheme** kiro's own desktop app catches. The browser cannot
  // follow that, so the flow has to intercept it — which is the part this fixture
  // is here to exercise.
  //
  // The Google walk in between is not reproduced here; it is covered end to end
  // by the qoder test above, which drives the same shared helper through four real
  // Google screens. Repeating it would double the slowest test in the suite to
  // prove something already proven.
  '/kiro-authorize': `<!doctype html><html><body>
    <h1>Authorize</h1>
    <script>
      if (!new URLSearchParams(location.search).get('code_challenge')) {
        document.body.innerHTML = '<p id="missing">no code challenge</p>';
      } else {
        setTimeout(() => {
          location.href = 'kiro://kiro.kiroAgent/authenticate-success?code=TEST-AUTH-CODE';
        }, 800);
      }
    </script>
  </body></html>`,
};

/**
 * Pages for hosts the flow must genuinely see, served through the browser.
 *
 * **Route interception rather than a fixture server, and the difference matters.**
 * Both of these flows leave the provider's site: kiro's authorization and qoder's
 * sign-in both run through Google, and each flow decides what to do by *which host
 * it is on*. A fixture server can only ever be one host, so serving Google from
 * one would have made those decisions untestable — and a flow rewritten to pass a
 * test like that would be a flow that no longer works. Fulfilling requests for the
 * real hostnames keeps the flow's own logic exactly as it ships.
 *
 * Keyed by `host + pathname`, so a redirect may carry a query the lookup ignores.
 */
const HOSTED: Record<string, string> = {
  // Google's four screens, in the order and shape a real account meets them.
  'accounts.google.com/v3/signin/identifier': `<!doctype html><html><body>
    <h1>Sign in with Google</h1>
    <input id="identifierId" />
    <button id="identifierNext">Next</button>
    <script>
      document.getElementById('identifierNext').addEventListener('click', () => {
        location.href = 'https://accounts.google.com/v3/signin/challenge/pwd?next=' +
          new URLSearchParams(location.search).get('next');
      });
    </script>
  </body></html>`,

  'accounts.google.com/v3/signin/challenge/pwd': `<!doctype html><html><body>
    <h1>Welcome</h1>
    <input name="Passwd" type="password" />
    <button id="passwordNext">Next</button>
    <script>
      document.getElementById('passwordNext').addEventListener('click', () => {
        location.href = 'https://accounts.google.com/speedbump/gaplustos?next=' +
          new URLSearchParams(location.search).get('next');
      });
    </script>
  </body></html>`,

  // The prompt a managed account owes. It is its own page, and it is on Google
  // rather than on the provider — which is why the walk clears it in the middle of
  // the hand-off rather than at either end.
  //
  // It is also the reason this fixture is split in two: a page that stays put when
  // its button is clicked is a page the walk clicks forever, and a fixture that
  // hangs the flow tests nothing.
  'accounts.google.com/speedbump/gaplustos': `<!doctype html><html><body>
    <h1>Welcome to your new account</h1>
    <button id="gaplustosNext">I understand</button>
    <script>
      document.getElementById('gaplustosNext').addEventListener('click', () => {
        location.href = 'https://accounts.google.com/signin/oauth/legacy/consent?next=' +
          new URLSearchParams(location.search).get('next');
      });
    </script>
  </body></html>`,

  'accounts.google.com/signin/oauth/legacy/consent': `<!doctype html><html><body>
    <h1>Choose an account</h1>
    <button id="submit_approve_access">Continue</button>
    <script>
      document.getElementById('submit_approve_access').addEventListener('click', () => {
        // kiro's callback is a custom scheme the browser cannot open, which is the
        // whole point: the flow catches the redirect instead of following it.
        location.href = new URLSearchParams(location.search).get('next') === 'kiro'
          ? 'kiro://kiro.kiroAgent/authenticate-success?code=TEST-AUTH-CODE'
          : 'https://qoder.com/account/profile';
      });
    </script>
  </body></html>`,

  // qoder's Google entry point, and the two pages behind it.
  'qoder.com/sso/login/google': `<!doctype html><html><body>
    <h1>Sign in with Google</h1>
    <script>
      location.href = 'https://accounts.google.com/v3/signin/identifier?next=qoder';
    </script>
  </body></html>`,

  // The account page a sign-in lands on. It carries a name and an address and no
  // key anywhere, which is the finding this flow exists because of.
  'qoder.com/account/profile': `<!doctype html><html><body>
    <h1>Test Operator</h1>
    <p>operator@example.com</p>
  </body></html>`,

  // The token page. The shapes the flow keys on are all here: the control that
  // opens the form, the two required fields, a full month of day cells, and the
  // dialog that prints the token once.
  //
  // **The calendar accepts exactly one day, and it is the day a year from now.**
  // That is the assertion this fixture exists to make: a flow that picks any other
  // day — the last cell in the month, or the first — leaves Create disabled and
  // fails at the step that says so. Modelling the requirement rather than the
  // picker's incidental behaviour is deliberate; qoder's real calendar happens to
  // cap at a year out, so "the last cell" lands on the right date there for a
  // reason the flow did not choose.
  'qoder.com/account/integrations': `<!doctype html><html><body>
    <h1>Personal Access Tokens</h1>
    <button id="new">New Token</button>
    <div id="form" style="display:none">
      <input placeholder="Enter access token name" />
      <input placeholder="Set an expiration date" readonly />
      <div id="calendar">${Array.from({ length: 31 }, (_, index) => `<div class="ant-picker-cell-in-view"><span class="ant-picker-cell-inner">${String(index + 1)}</span></div>`).join('')}</div>
      <button id="create" disabled>Create</button>
    </div>
    <div role="dialog" id="dialog" style="display:none">
      <p>Your new personal access token has been created.</p>
      <code>pt-AbCdEfGhIjKlMnOpQrStUvWx</code>
    </div>
    <script>
      const form = document.getElementById('form');
      const create = document.getElementById('create');
      const field = document.querySelector('input[placeholder="Set an expiration date"]');
      const targetDay = '__TARGET_DAY__';
      document.getElementById('new').addEventListener('click', () => { form.style.display = 'block'; });
      for (const cell of document.querySelectorAll('.ant-picker-cell-inner')) {
        cell.addEventListener('click', () => {
          if (cell.textContent !== targetDay) return;
          field.value = '2027-' + targetDay;
          create.disabled = false;
        });
      }
      create.addEventListener('click', () => { document.getElementById('dialog').style.display = 'block'; });
    </script>
  </body></html>`,
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    // The token endpoints are JSON POSTs, and they are the one part of these flows
    // that does not run in the browser — both flows spend their credential with
    // `fetch`, so Playwright's routing cannot reach them and they land here.
    if (request.method === 'POST' && (path === '/oauth/token' || path === '/qoder-exchange')) {
      const body =
        path === '/oauth/token'
          ? {
              accessToken: 'kiro-access-token',
              refreshToken: 'kiro-refresh-token',
              profileArn: 'arn:aws:codewhisperer:::profile/TEST',
            }
          : { token: 'qoder-exchanged-token', refresh_token: 'qoder-refresh-token' };
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(body));
      return;
    }

    serve(request, response, PAGES);
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

/**
 * Serve the hosts a flow must actually be on.
 *
 * Installed through the driver's `configureContext`, which is the only place that
 * can reach the context the flow runs in.
 */
async function installHostRoutes(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const owned = url.host === 'accounts.google.com' || url.host === 'qoder.com';
    if (!owned) {
      await route.continue();
      return;
    }
    const page = HOSTED[`${url.host}${url.pathname}`];
    if (page === undefined) {
      // A host this test owns but a path it does not know: answered rather than
      // sent to the real site, so a flow that wanders shows up as a 404 in the
      // step detail instead of as a live request to somebody's production.
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: render(page) });
  });
}

function item(credential: string): WorkerItem {
  return { id: 'i1', label: 'a***@example.com', credential };
}

function jobFor(path: string, overrides: Partial<WorkerJob> = {}): WorkerJob {
  return {
    jobId: 'j1',
    // `codebuddy-intl`, because it is the provider the heuristic still serves.
    // This used to be `kiro`, until kiro's real sign-in turned out to be Google's
    // and it got a flow of its own — so a fixture that proves the *heuristic*
    // works has to name a provider the heuristic is still what drives.
    providerId: 'codebuddy-intl',
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
    /** Serves the hosts a flow leaves the fixture server for. */
    readonly hosts?: boolean;
  } = {},
): Promise<{ recorded: Recorded; account: { credential: string; label: string } }> {
  const recorded: Recorded = { steps: [], frames: [], manualAsks: [] };
  const resolved = resolveFlow(job);
  const driver = createPlaywrightDriver({
    flow: resolved.flow,
    ...(resolved.reason === null ? {} : { noFlowReason: resolved.reason }),
    previewIntervalMs: 100_000,
    ...(options.hosts === true ? { configureContext: installHostRoutes } : {}),
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
  // Every test here launches a real browser, so every one of them carries an
  // explicit timeout. The default is five seconds, which is ample for a browser
  // launch on an idle machine and not ample when the whole suite runs at once —
  // and a test that fails only under load is a test whose failure says nothing
  // about the code. One of these did exactly that before the timeouts were added.
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
  }, 60_000);

  it('finds an untyped sign-in form, which is what the fallback selector is for', async () => {
    const { account } = await runFlow(jobFor('/signin-plain'));
    expect(account.credential).toContain('sk-proj-');
  }, 60_000);

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
  }, 60_000);
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

describe('the qoder flow', () => {
  /**
   * qoder's job, pointed at the Google entry point its manifest names.
   *
   * The start URL is the real one — the flow navigates to whatever the manifest
   * says — and the host is served by the test's own routing, so the flow runs its
   * shipped logic against the hostname it ships with.
   */
  const qoderJob = (): WorkerJob =>
    jobFor('', {
      providerId: 'qoder',
      automation: {
        login: 'browser',
        startUrl: 'https://qoder.com/sso/login/google?oauth_callback=https://qoder.com/account/profile',
        captcha: true,
        humanTimeoutSeconds: 180,
      },
    });

  /**
   * The exchange runs through `fetch`, which Playwright's routing cannot reach, so
   * it is pointed at the fixture server instead.
   */
  const withExchange = async <T>(work: () => Promise<T>): Promise<T> => {
    process.env['RUTEKIT_QODER_EXCHANGE_URL'] = `${base}/qoder-exchange`;
    try {
      return await work();
    } finally {
      delete process.env['RUTEKIT_QODER_EXCHANGE_URL'];
    }
  };

  it('signs in with Google, mints a token, and spends it on the real credential', async () => {
    const { account, recorded } = await withExchange(() => runFlow(qoderJob(), { hosts: true }));

    // What is stored is the exchanged token, not the PAT: the PAT is shown once
    // and is worth nothing until qoder has been asked to honour it.
    const credential = JSON.parse(account.credential) as Record<string, unknown>;
    expect(credential['securityOauthToken']).toBe('qoder-exchanged-token');
    expect(credential['refreshToken']).toBe('qoder-refresh-token');
    expect(credential['personalToken']).toBe('pt-AbCdEfGhIjKlMnOpQrStUvWx');
    expect(credential['email']).toBe('alice@example.com');

    expect(namesOf(recorded)).toEqual([
      'open',
      'sign in with Google',
      'wait for qoder',
      'create a token',
      'exchange the token',
    ]);
  }, 120_000);

  it('refuses an item that is not an email and a password', async () => {
    // A bare token is what `bulk-token` is for, and saying so beats driving a
    // Google sign-in with an empty password.
    const job = qoderJob();
    const withToken = { ...job, items: [item('just-a-token')] };

    await expect(runFlow(withToken, { hosts: true })).rejects.toThrow(/needs `email:password`/u);
  }, 60_000);
});

describe('the kiro flow', () => {
  /**
   * kiro's job, pointed at the authorization endpoint its manifest names.
   *
   * The flow appends its own PKCE challenge to this URL, so the fixture stands in
   * for an endpoint that expects one — and says so when it does not get it.
   */
  const kiroJob = (): WorkerJob =>
    jobFor('', {
      providerId: 'kiro',
      automation: {
        login: 'browser',
        startUrl: `${base}/kiro-authorize`,
        captcha: true,
        humanTimeoutSeconds: 180,
      },
    });

  it('takes an authorization code through Google and exchanges it for the token pair', async () => {
    const { account, recorded } = await runFlow(kiroJob());

    // The credential is the token pair, which is the whole finding: there is no
    // key on any page kiro serves, and this is what it issues instead.
    const credential = JSON.parse(account.credential) as Record<string, unknown>;
    expect(credential['accessToken']).toBe('kiro-access-token');
    expect(credential['refreshToken']).toBe('kiro-refresh-token');
    expect(credential['profileArn']).toContain('profile/TEST');
    expect(credential['email']).toBe('alice@example.com');

    expect(namesOf(recorded)).toEqual([
      'open',
      'sign in with Google',
      'read the authorization code',
      'exchange the code',
    ]);
  }, 120_000);

  it('refuses an item that is not an email and a password', async () => {
    const job = kiroJob();
    const withToken = { ...job, items: [item('just-a-token')] };

    await expect(runFlow(withToken)).rejects.toThrow(/needs `email:password`/u);
  }, 60_000);
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
