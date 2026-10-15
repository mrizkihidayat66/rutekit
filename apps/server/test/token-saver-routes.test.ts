import { afterEach, describe, expect, it } from 'vitest';
import type { ApiKeyInput, TokenSaverConfig, TokenSaverSavings } from '@contracts';
import { CONSOLE_API_PREFIX, consolePaths, tokenSaverSavingsSchema } from '@contracts';

import { buildApp } from '@server/app.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { encodeSavings, storedSavingsOf } from '@server/telemetry/savings.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The Token Saver's console (C14, FR-1.2 / A3).
 *
 * The last piece of FASE C to land, and it landed here because D1's contract test
 * found it missing rather than because anyone remembered it. So the tests are
 * written against the two things that were actually absent: **the routes answer**
 * (which the contract test already asserts, and this file drives end to end) and
 * **the numbers are right** (which nothing did, because nothing stored them).
 *
 * The savings half is the interesting one. A page that shows a plausible number
 * is indistinguishable from a page that shows a correct one, so the cases below
 * pin the arithmetic to a body whose size is known: a request is compressed, the
 * row is read back, and the figures are checked against the pipeline's own
 * byte accounting rather than against whatever the code happened to produce.
 */

const KEY_HEX = 'a'.repeat(64);
const OPENAI_KEY = 'sk-openai-test';
const PASSWORD = 'correct-horse-battery';

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

interface Call {
  readonly url: string;
  readonly body: string;
}

function responder(answer: (call: Call) => Response): {
  fetcher: ResponseFetcher;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetcher: ResponseFetcher = (url, init) => {
    calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
    return Promise.resolve(answer(calls[calls.length - 1]!));
  };
  return { fetcher, calls };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly box: SecretBox;
  readonly cookie: string;
}

async function signIn(app: App): Promise<string> {
  const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authSetup}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, instanceName: 'Test' }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup did not set a session cookie');
  const pair = setCookie.split(';')[0];
  if (pair === undefined) throw new Error('empty set-cookie header');
  return pair;
}

async function harness(fetcher: ResponseFetcher): Promise<Harness> {
  const box = new SecretBox(KEY_HEX);
  const server = makeServer({ secrets: box, fetch: fetcher });
  server.lifecycle.markReady();
  servers.push(server);

  const app = buildApp(server);
  const at = new Date().toISOString();
  server.accounts.create({
    id: crypto.randomUUID(),
    providerId: 'openai',
    label: 'openai test',
    credentialEnvelope: box.encrypt(OPENAI_KEY),
    authMode: 'api-key',
    createdAt: at,
    updatedAt: at,
  });

  return { server, app, box, cookie: await signIn(app) };
}

function mintKey(server: TestServer): string {
  const input: ApiKeyInput = {
    name: 'test',
    modelsAllowed: [],
    modelsDenied: [],
    budgetRequests: null,
    budgetTokens: null,
    tpsLimit: null,
    rateLimitPerMinute: null,
    expiresAt: null,
    clientRouterDenylist: [],
  };
  return server.apiKeys.create(input).secret;
}

/** A turn big enough that the pipeline has something to remove. */
const BIG_TURN = {
  messages: [
    { role: 'system', content: 'You are a careful assistant. '.repeat(60) },
    { role: 'user', content: 'Explain the difference between TCP and UDP. '.repeat(40) },
  ],
};

async function runTurn(h: Harness, body: unknown = BIG_TURN): Promise<Response> {
  return h.app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${mintKey(h.server)}`,
    },
    body: JSON.stringify({ model: 'gpt-4o', ...(body as object) }),
  });
}

async function readSavings(h: Harness, window = '24h'): Promise<TokenSaverSavings> {
  const response = await h.app.request(
    `${CONSOLE_API_PREFIX}${consolePaths.tokenSaverSavings}?window=${window}`,
    { headers: { cookie: h.cookie } },
  );
  expect(response.status).toBe(200);
  return tokenSaverSavingsSchema.parse(await response.json());
}

async function readConfig(h: Harness): Promise<TokenSaverConfig> {
  const response = await h.app.request(`${CONSOLE_API_PREFIX}${consolePaths.tokenSaver}`, {
    headers: { cookie: h.cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as TokenSaverConfig;
}

/* ---- The stored document ---- */

describe('what a turn stores', () => {
  it('records the sizes the pipeline measured, not the whole body', () => {
    const stored = storedSavingsOf({
      bytesIn: 4_000,
      bytesOut: 3_000,
      stages: [
        { stageId: 'tsc', bytesIn: 4_000, bytesOut: 3_400, tokensSaved: 150, failed: false },
        { stageId: 'rtk', bytesIn: 3_400, bytesOut: 3_000, tokensSaved: 100, failed: false },
      ],
    });

    expect(stored).not.toBeNull();
    expect(stored?.tokensIn).toBe(1_000);
    expect(stored?.tokensSaved).toBe(250);
    // Derived from the two figures above, so the bars always sum to the headline.
    expect(stored?.tokensOut).toBe(750);
    // `failed` is dropped: a stage that threw saves nothing, which is already
    // visible as a zero, and a flag nobody acts on differently only drifts.
    expect(stored?.stages[0]).toEqual({
      stageId: 'tsc',
      bytesIn: 4_000,
      bytesOut: 3_400,
      tokensSaved: 150,
    });
  });

  it('stores nothing when the pipeline did not run', () => {
    // Null rather than a zero report, and the difference is load-bearing:
    // `requestsProcessed` counts compressed turns, and a zero report would make
    // a turn the Token Saver never touched indistinguishable from one it could
    // not shrink.
    expect(storedSavingsOf({ bytesIn: 100, bytesOut: 100, stages: [] })).toBeNull();
    expect(encodeSavings({ bytesIn: 100, bytesOut: 100, stages: [] })).toBeNull();
  });
});

/* ---- End to end ---- */

describe('a compressed turn', () => {
  it('lands a savings record on its own row', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const h = await harness(fetcher);

    const response = await runTurn(h);
    expect(response.status).toBe(200);

    const rows = h.server.requests.listBetween(
      new Date(0).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
      {},
      10,
    );
    expect(rows).toHaveLength(1);

    const raw = rows[0]?.tokenSaverSavings;
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw ?? 'null') as {
      tokensIn: number;
      tokensOut: number;
      tokensSaved: number;
      stages: { stageId: string }[];
    };
    expect(stored.tokensIn).toBeGreaterThan(0);
    expect(stored.stages.length).toBeGreaterThan(0);
    expect(stored.tokensIn).toBe(stored.tokensOut + stored.tokensSaved);
  });

  it('reports it back through the savings route', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const h = await harness(fetcher);
    await runTurn(h);

    const savings = await readSavings(h);

    expect(savings.window).toBe('24h');
    expect(savings.requestsProcessed).toBe(1);
    expect(savings.tokensIn).toBeGreaterThan(0);
    expect(savings.tokensSaved).toBe(savings.tokensIn - savings.tokensOut);
    // The stages are ordered the way the request passes through them, not the way
    // SQL's `group by` happened to return them.
    const ids = savings.perStage.map((stage) => stage.stageId);
    expect(ids).toEqual([...ids].sort((left, right) => ORDER.indexOf(left) - ORDER.indexOf(right)));
  });

  it('counts only the turns the pipeline ran on', async () => {
    const { fetcher } = responder((call) =>
      call.url.includes('/chat/completions') ? jsonResponse(COMPLETION) : jsonResponse({}),
    );
    const h = await harness(fetcher);

    await runTurn(h);
    // A refusal that never reaches the provider: no row at all, so nothing to count.
    const refused = await h.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-key' },
      body: JSON.stringify({ model: 'gpt-4o', ...BIG_TURN }),
    });
    expect(refused.status).toBe(401);

    const savings = await readSavings(h);
    expect(savings.requestsProcessed).toBe(1);
  });

  it('answers a fresh instance with zeroes rather than an error', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const h = await harness(fetcher);

    const savings = await readSavings(h);

    // A ratio of 0/0 is undefined, not zero, and the contract's minimum is 0 —
    // so this is the boundary the read model has to clamp.
    expect(savings.requestsProcessed).toBe(0);
    expect(savings.tokensSaved).toBe(0);
    expect(savings.ratio).toBe(0);
    expect(savings.perStage).toEqual([]);
    // The trend is still a full grid of zeroes: a chart with no points would
    // render as nothing rather than as a quiet week.
    expect(savings.series.length).toBeGreaterThan(0);
    expect(savings.series.every((point) => point.tokensSaved === 0)).toBe(true);
  });

  it('rejects an unknown window rather than falling back to a default', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const h = await harness(fetcher);

    const response = await h.app.request(
      `${CONSOLE_API_PREFIX}${consolePaths.tokenSaverSavings}?window=fortnight`,
      { headers: { cookie: h.cookie } },
    );

    expect(response.status).toBe(400);
  });
});

/* ---- The settings record ---- */

describe('the settings record', () => {
  it('reads back the defaults before anything is written', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const h = await harness(fetcher);

    const config = await readConfig(h);

    // Caveman is the one stage off by default: it rewrites prose rather than
    // dropping what is provably redundant, which is the operator's call to make.
    expect(config.enabled).toBe(true);
    expect(config.stages.caveman).toBe(false);
    expect(config.cavemanTier).toBe('off');
  });

  it('merges a patch rather than replacing the record', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const h = await harness(fetcher);

    const first = await patchConfig(h, { cavemanTier: 'lite' });
    expect(first.cavemanTier).toBe('lite');
    expect(first.enabled).toBe(true);

    // The field the second patch did not name is still there — a replace would
    // have reset `enabled`, which is the switch the whole feature hangs on.
    const second = await patchConfig(h, { enabled: false });
    expect(second.enabled).toBe(false);
    expect(second.cavemanTier).toBe('lite');
    expect(second.rtkPreset).toBe(first.rtkPreset);
  });

  it('stamps updatedAt on every write', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const h = await harness(fetcher);

    const before = await readConfig(h);
    const after = await patchConfig(h, { enabled: false });

    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
  });

  it('refuses a value outside the contract', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const h = await harness(fetcher);

    const response = await h.app.request(`${CONSOLE_API_PREFIX}${consolePaths.tokenSaver}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: h.cookie },
      body: JSON.stringify({ cavemanTier: 'extreme' }),
    });

    expect(response.status).toBe(400);
  });

  it('turns the pipeline off, and stops recording savings for later turns', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const h = await harness(fetcher);
    await runTurn(h);
    expect((await readSavings(h)).requestsProcessed).toBe(1);

    await patchConfig(h, { enabled: false });
    await runTurn(h);

    // The first turn's savings are still there; the second wrote none, because
    // the pipeline did not run on it at all.
    const savings = await readSavings(h);
    expect(savings.requestsProcessed).toBe(1);
  });
});

async function patchConfig(h: Harness, patch: Record<string, unknown>): Promise<TokenSaverConfig> {
  const response = await h.app.request(`${CONSOLE_API_PREFIX}${consolePaths.tokenSaver}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: h.cookie },
    body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as TokenSaverConfig;
}

/** The pipeline's own order, so the sort assertion above does not restate it. */
const ORDER = ['tsc', 'dcp', 'rtk', 'caveman', 'cacheMarkers'];
