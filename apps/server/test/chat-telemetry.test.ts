import { afterEach, describe, expect, it } from 'vitest';
import { CONSOLE_API_PREFIX, chatSessionSchema, consolePaths } from '@contracts';
import type { ChatSession } from '@contracts';

import { buildApp } from '@server/app.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * What a console chat turn writes down (D4, FR-12.2–12.4).
 *
 * The chat console is the second front door to `callModel`, and until this was
 * fixed it recorded **nothing**: `ChatTurnDeps` had no recorder, so a console turn
 * appeared in no request log, in no usage chart, and — because the savings read
 * model sums over the `requests` table — its Token Saver savings were not counted
 * at all. The page's numbers were lower than the savings actually happening, and
 * nothing said so.
 *
 * The cases are the endings, because that is what a telemetry row has to cover:
 * a turn that answered, a turn that failed before its first token, and a turn
 * that was refused outright. The last two are the ones the old code lost, and
 * they are the ones an operator opens the log to find.
 */

const PASSWORD = 'correct-horse-battery';
const KEY_HEX = 'ab'.repeat(32);
const OPENAI_KEY = 'sk-openai-test';

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function responder(answer: (call: Call) => Response): { fetcher: ResponseFetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: ResponseFetcher = (url, init) => {
    const raw = typeof init.body === 'string' ? init.body : '{}';
    const call: Call = { url, body: JSON.parse(raw) as Record<string, unknown> };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetcher, calls };
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'gpt-4o',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;
}

const FINISH_FRAME = chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
const USAGE_FRAME = `data: ${JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1_700_000_000,
  model: 'gpt-4o',
  choices: [],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
})}\n\n`;

const ANSWERED = [chunk({ role: 'assistant', content: 'Hello' }), FINISH_FRAME, USAGE_FRAME].join(
  '',
);

interface Harness {
  readonly server: TestServer;
  readonly app: App;
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

async function harness(options: {
  fetcher: ResponseFetcher;
  withAccount?: boolean;
}): Promise<Harness> {
  const box = new SecretBox(KEY_HEX);
  const server = makeServer({ secrets: box, fetch: options.fetcher });
  server.lifecycle.markReady();
  servers.push(server);

  if (options.withAccount !== false) {
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
  }

  const app = buildApp(server);
  return { server, app, cookie: await signIn(app) };
}

const SESSIONS = `${CONSOLE_API_PREFIX}${consolePaths.chatSessions}`;
const messagesPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.chatMessages.replace(':id', id)}`;

const TURN = {
  role: 'user',
  content: [{ type: 'text', text: 'Hi' }],
  attachments: [],
  parentMessageId: null,
  providerId: null,
  model: null,
  thinkingLevel: 'auto',
} as const;

async function newSession(h: Harness): Promise<ChatSession> {
  const response = await h.app.request(SESSIONS, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: h.cookie },
    body: JSON.stringify({ title: 'Chat', providerId: 'openai', model: 'gpt-4o' }),
  });
  return chatSessionSchema.parse(await response.json());
}

async function runTurn(h: Harness, sessionId: string): Promise<Response> {
  return h.app.request(messagesPath(sessionId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: h.cookie },
    body: JSON.stringify(TURN),
  });
}

/** Every row the console wrote, newest first. */
function rowsOf(h: Harness) {
  return h.server.requests.listBetween(
    new Date(0).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
    {},
    20,
  );
}

describe('a console turn that answered', () => {
  it('writes one row, attributed to the provider and the account', async () => {
    const { fetcher } = responder(() => sseResponse(ANSWERED));
    const h = await harness({ fetcher });
    const session = await newSession(h);

    const response = await runTurn(h, session.id);
    expect(response.status).toBe(200);
    await response.text();

    const rows = rowsOf(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerId).toBe('openai');
    expect(rows[0]?.model).toBe('gpt-4o');
    expect(rows[0]?.status).toBe(200);
    expect(rows[0]?.streamed).toBe(true);
    // The usage the provider reported, which for a stream arrives in the last
    // frame — long after the row could have been written at the start.
    expect(rows[0]?.inputTokens).toBe(3);
    expect(rows[0]?.outputTokens).toBe(2);
  });

  it('names the console route, not a /v1 surface', async () => {
    const { fetcher } = responder(() => sseResponse(ANSWERED));
    const h = await harness({ fetcher });
    const session = await newSession(h);
    await (await runTurn(h, session.id)).text();

    // The path is what tells the two front doors apart in the request log, and
    // it is the only field that does: both are one row with one provider.
    expect(rowsOf(h)[0]?.path).toContain('/chat/sessions/');
  });

  it('carries no API key, because the console opens with a cookie', async () => {
    const { fetcher } = responder(() => sseResponse(ANSWERED));
    const h = await harness({ fetcher });
    const session = await newSession(h);
    await (await runTurn(h, session.id)).text();

    // Attributing a console turn to a key would be a lie: no key was presented.
    expect(rowsOf(h)[0]?.apiKeyId).toBeNull();
  });
});

describe('what the row means for the rest of the console', () => {
  it('counts a console turn in the Token Saver’s savings', async () => {
    // The deeper half of the bug, and the reason this is not just "a missing
    // log line": the savings read model sums over `requests`, so a turn with no
    // row contributed nothing. The page reported savings lower than the ones
    // actually happening, with no way for an operator to tell.
    const { fetcher } = responder(() => sseResponse(ANSWERED));
    const h = await harness({ fetcher });
    const session = await newSession(h);

    await (await runTurn(h, session.id)).text();

    const response = await h.app.request(
      `${CONSOLE_API_PREFIX}${consolePaths.tokenSaverSavings}?window=24h`,
      { headers: { cookie: h.cookie } },
    );
    const savings = (await response.json()) as { requestsProcessed: number };

    expect(savings.requestsProcessed).toBe(1);
  });

  it('appears in the usage summary as a request', async () => {
    const { fetcher } = responder(() => sseResponse(ANSWERED));
    const h = await harness({ fetcher });
    const session = await newSession(h);

    await (await runTurn(h, session.id)).text();

    const response = await h.app.request(
      `${CONSOLE_API_PREFIX}${consolePaths.usageSummary}?window=24h`,
      { headers: { cookie: h.cookie } },
    );
    const summary = (await response.json()) as { requests: number };

    expect(summary.requests).toBe(1);
  });
});

describe('a console turn that failed', () => {
  it('writes a row when the provider refuses', async () => {
    // A 500 from upstream. The stream opens and then dies, which is the shape
    // that reaches `onStreamEnd` with `ok: false`.
    const { fetcher } = responder(() => new Response('nope', { status: 500 }));
    const h = await harness({ fetcher });
    const session = await newSession(h);

    const response = await runTurn(h, session.id);
    await response.text().catch(() => '');

    const rows = rowsOf(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBeGreaterThanOrEqual(400);
  });

  it('writes a row when there is no account to send with', async () => {
    // Nothing was called at all — this is the case the old code lost entirely,
    // because `onStreamEnd` never fires when `callModel` throws.
    const { fetcher } = responder(() => sseResponse(ANSWERED));
    const h = await harness({ fetcher, withAccount: false });
    const session = await newSession(h);

    const response = await runTurn(h, session.id);
    await response.text().catch(() => '');

    const rows = rowsOf(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBeGreaterThanOrEqual(400);
    // No account was taken, so the row names none — and says so rather than
    // inventing one.
    expect(rows[0]?.accountId).toBeNull();
  });

  it('writes exactly one row per attempt, however the turn ended', async () => {
    // The guard against a turn being counted twice: once from `onStreamEnd` and
    // once from the catch. A double row would double every console turn in the
    // usage charts.
    const { fetcher } = responder(() => new Response('nope', { status: 503 }));
    const h = await harness({ fetcher });
    const session = await newSession(h);

    await (await runTurn(h, session.id)).text().catch(() => '');

    expect(rowsOf(h)).toHaveLength(1);
  });
});
