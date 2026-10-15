import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  chatSessionSchema,
  chatSessionsResponseSchema,
  consoleErrorSchema,
  consolePaths,
} from '@contracts';
import type { ChatSession } from '@contracts';

import { buildApp } from '@server/app.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { providerManifests } from '@registry/providers/index.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The Chat console, end to end (C9, FR-7.7–7.10).
 *
 * A real composition with only the socket replaced: the session guard, the chat
 * routes, the turn runner, `callModel`, the translator's pivot and codecs, and
 * the Token Saver. What these assert is what an operator can actually observe —
 * the frames on the wire, the transcript the next request is built from, and the
 * metadata recorded under the reply.
 *
 * The turn is the one console route that does not answer with a document, so
 * most of what is worth pinning is about the stream: that the frames are the AI
 * SDK's protocol in the order its reader requires, that the reply is stored
 * *before* the body closes, and that a turn which produced nothing is not stored
 * at all.
 */

const PASSWORD = 'correct-horse-battery';
const KEY_HEX = 'ab'.repeat(32);
const OPENAI_KEY = 'sk-openai-test';
const ANTHROPIC_KEY = 'sk-ant-test';

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

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

interface Call {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function responder(answer: (call: Call) => Response): { fetcher: ResponseFetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: ResponseFetcher = (url, init) => {
    const raw = typeof init.body === 'string' ? init.body : '{}';
    const call: Call = {
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(raw) as Record<string, unknown>,
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetcher, calls };
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One `chat.completion.chunk`, as an OpenAI provider writes them. */
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

const USAGE_FRAME = `data: ${JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1_700_000_000,
  model: 'gpt-4o',
  choices: [],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
})}\n\n`;

/**
 * The one anthropic-family model that declares `reasoning`.
 *
 * Asked of the registry rather than written down: it is the BYOK Messages
 * manifest's placeholder, and a literal here would be a second copy of the
 * catalogue that goes stale the first time the manifest is renamed.
 */
const REASONING_ON_MESSAGES =
  providerManifests
    .find((manifest) => manifest.id === 'byok-anthropic')
    ?.models?.find((model) => model.capabilities?.reasoning === true)?.id ?? '';

const FINISH_FRAME = chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly cookie: string;
  readonly box: SecretBox;
}

async function harness(options: {
  fetcher: ResponseFetcher;
  accounts?: readonly { providerId: string; credential: string }[];
}): Promise<Harness> {
  const box = new SecretBox(KEY_HEX);
  const server = makeServer({ secrets: box, fetch: options.fetcher, env: {} });
  server.lifecycle.markReady();
  servers.push(server);

  const at = new Date().toISOString();
  for (const account of options.accounts ?? []) {
    server.accounts.create({
      id: crypto.randomUUID(),
      providerId: account.providerId,
      label: `${account.providerId} test`,
      credentialEnvelope: box.encrypt(account.credential),
      authMode: 'api-key',
      createdAt: at,
      updatedAt: at,
    });
  }

  const app = buildApp(server);
  return { server, app, cookie: await signIn(app), box };
}

async function call(
  app: App,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return app.request(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const SESSIONS = `${CONSOLE_API_PREFIX}${consolePaths.chatSessions}`;
const sessionPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.chatSession.replace(':id', id)}`;
const messagesPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.chatMessages.replace(':id', id)}`;
const exportPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.chatExport.replace(':id', id)}`;

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

/** Create a session pinned to a provider and a model, as the console's header does. */
async function newSession(
  h: Harness,
  overrides: Record<string, unknown> = {},
): Promise<ChatSession> {
  const response = await call(h.app, SESSIONS, {
    method: 'POST',
    cookie: h.cookie,
    body: { title: 'Chat', providerId: 'openai', model: 'gpt-4o', ...overrides },
  });
  expect(response.status).toBe(201);
  return chatSessionSchema.parse(await response.json());
}

/**
 * The chunks of an SSE body, in order.
 *
 * The `[DONE]` sentinel is a `data:` line but not JSON, so it is dropped here
 * rather than by each caller — its presence is asserted separately, because
 * "the reader can stop" is its own property.
 */
function framesOf(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as unknown);
}

const TURN = {
  role: 'user',
  content: [{ type: 'text', text: 'Hi' }],
  attachments: [],
  parentMessageId: null,
  providerId: null,
  model: null,
  thinkingLevel: 'auto',
} as const;

/* ---- Sessions ---- */

describe('the session list', () => {
  it('creates, lists, renames and deletes a conversation', async () => {
    const { fetcher } = responder(() => sseResponse(''));
    const h = await harness({ fetcher });

    const session = await newSession(h);

    const listed = chatSessionsResponseSchema.parse(
      await (await call(h.app, SESSIONS, { cookie: h.cookie })).json(),
    );
    expect(listed.items.map((row) => row.id)).toEqual([session.id]);
    // A new conversation has nothing to preview, and the sidebar still has to
    // render a row for it.
    expect(listed.items[0]?.preview).toBe('');
    expect(listed.items[0]?.messageCount).toBe(0);

    const renamed = chatSessionSchema.parse(
      await (
        await call(h.app, sessionPath(session.id), {
          method: 'PATCH',
          cookie: h.cookie,
          body: { title: 'Renamed' },
        })
      ).json(),
    );
    expect(renamed.title).toBe('Renamed');
    // A PATCH that names one field leaves the rest alone — the header's model
    // picker must not be reset by a rename.
    expect(renamed.model).toBe('gpt-4o');

    const deleted = await call(h.app, sessionPath(session.id), {
      method: 'DELETE',
      cookie: h.cookie,
    });
    expect(deleted.status).toBe(200);

    const after = chatSessionsResponseSchema.parse(
      await (await call(h.app, SESSIONS, { cookie: h.cookie })).json(),
    );
    expect(after.items).toEqual([]);
  });

  it('answers not_found for a session that is not there', async () => {
    const { fetcher } = responder(() => sseResponse(''));
    const h = await harness({ fetcher });

    const response = await call(h.app, sessionPath('nope'), { cookie: h.cookie });

    expect(response.status).toBe(404);
    expect((await errorOf(response)).kind).toBe('not_found');
  });

  it('refuses an anonymous caller', async () => {
    const { fetcher } = responder(() => sseResponse(''));
    const h = await harness({ fetcher });

    const response = await call(h.app, SESSIONS);

    expect(response.status).toBe(401);
  });
});

/* ---- A turn ---- */

describe('a chat turn', () => {
  it('streams the AI SDK’s frames in the order its reader requires', async () => {
    const upstream = [
      chunk({ role: 'assistant', content: 'Hello' }),
      chunk({ content: ' there.' }),
      FINISH_FRAME,
      USAGE_FRAME,
      'data: [DONE]\n\n',
    ].join('');
    const { fetcher } = responder(() => sseResponse(upstream));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    const response = await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: TURN,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const frames = framesOf(await response.text()).map(
      (frame) => (frame as { type: string }).type,
    );
    // A delta without its start frame makes the client throw, so the order is
    // the protocol and not a preference.
    expect(frames[0]).toBe('start');
    expect(frames).toContain('text-start');
    expect(frames).toContain('text-delta');
    expect(frames.indexOf('text-start')).toBeLessThan(frames.indexOf('text-delta'));
    expect(frames.indexOf('text-delta')).toBeLessThan(frames.indexOf('text-end'));
    expect(frames[frames.length - 1]).toBe('finish');
  });

  it('closes with the [DONE] sentinel the SDK’s reader stops on', async () => {
    const { fetcher } = responder(() =>
      sseResponse([chunk({ role: 'assistant', content: 'Hi' }), FINISH_FRAME, USAGE_FRAME].join('')),
    );
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    const text = await (
      await call(h.app, messagesPath(session.id), { method: 'POST', cookie: h.cookie, body: TURN })
    ).text();

    // Without it the page's reader waits for ever, which is a hang rather than an
    // error — the worst shape a bug can take in a streaming UI.
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('stores the turn and the reply, and builds the next request from both', async () => {
    const upstream = [chunk({ role: 'assistant', content: 'Hi there.' }), FINISH_FRAME, USAGE_FRAME].join('');
    const { fetcher, calls } = responder(() => sseResponse(upstream));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    await call(h.app, messagesPath(session.id), { method: 'POST', cookie: h.cookie, body: TURN });

    const stored = chatSessionSchema.parse(
      await (await call(h.app, sessionPath(session.id), { cookie: h.cookie })).json(),
    );
    expect(stored.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(stored.messages[1]?.content).toEqual([{ type: 'text', text: 'Hi there.' }]);

    // The reply was written *before* the body closed, so a client that reads
    // `[DONE]` and immediately re-fetches the session finds it there.
    const sent = calls[0]?.body as { messages: { role: string; content: unknown }[] };
    expect(sent.messages).toEqual([{ role: 'user', content: 'Hi' }]);

    // A second turn sends the whole conversation, read from the transcript
    // rather than from the client — which is what makes a resumed chat identical
    // to one that never left the page.
    await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: { ...TURN, content: [{ type: 'text', text: 'Again' }] },
    });

    const second = calls[1]?.body as { messages: { role: string; content: unknown }[] };
    expect(second.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: 'Again' },
    ]);
  });

  it('records what the reply cost under it (FR-7.9)', async () => {
    const upstream = [chunk({ role: 'assistant', content: 'Hi' }), FINISH_FRAME, USAGE_FRAME].join('');
    const { fetcher } = responder(() => sseResponse(upstream));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    await call(h.app, messagesPath(session.id), { method: 'POST', cookie: h.cookie, body: TURN });

    const stored = chatSessionSchema.parse(
      await (await call(h.app, sessionPath(session.id), { cookie: h.cookie })).json(),
    );
    const meta = stored.messages[1]?.meta;
    expect(meta?.usage?.inputTokens).toBe(3);
    expect(meta?.usage?.outputTokens).toBe(2);
    expect(meta?.finishReason).toBe('stop');
    expect(meta?.providerId).toBe('openai');
    expect(meta?.model).toBe('gpt-4o');
    // A user turn has nothing to record, and the console renders the meta row
    // only when there is one.
    expect(stored.messages[0]?.meta).toBeNull();
  });

  it('shows the newest turn in the sidebar preview', async () => {
    const upstream = [chunk({ role: 'assistant', content: 'The answer.' }), FINISH_FRAME, USAGE_FRAME].join('');
    const { fetcher } = responder(() => sseResponse(upstream));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    await call(h.app, messagesPath(session.id), { method: 'POST', cookie: h.cookie, body: TURN });

    const listed = chatSessionsResponseSchema.parse(
      await (await call(h.app, SESSIONS, { cookie: h.cookie })).json(),
    );
    expect(listed.items[0]?.preview).toBe('The answer.');
    expect(listed.items[0]?.messageCount).toBe(2);
  });
});

/* ---- The reply that produced nothing ---- */

describe('a turn that produced nothing', () => {
  it('stores the operator’s message but not an empty reply', async () => {
    // A provider that failed before its first token left nothing on the screen,
    // so there is nothing to remember. Storing an empty turn would also send it
    // back to the model on the next request.
    const { fetcher } = responder(() =>
      new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    const response = await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: TURN,
    });

    // The failure is a status code, because nothing had been committed yet.
    expect(response.status).toBe(502);

    const stored = chatSessionSchema.parse(
      await (await call(h.app, sessionPath(session.id), { cookie: h.cookie })).json(),
    );
    expect(stored.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('keeps a half answer the operator read, marked as an error', async () => {
    // The other half of the same rule: a stream that died mid-answer left half a
    // sentence on the screen, and that half is what the operator saw.
    const upstream = [chunk({ role: 'assistant', content: 'Half a sen' }), 'data: [DONE]\n\n'].join('');
    const { fetcher } = responder(() => sseResponse(upstream));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    const response = await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: TURN,
    });
    await response.text();

    const stored = chatSessionSchema.parse(
      await (await call(h.app, sessionPath(session.id), { cookie: h.cookie })).json(),
    );
    expect(stored.messages[1]?.content).toEqual([{ type: 'text', text: 'Half a sen' }]);
    // The provider never said how it ended, so the stored record says the truth:
    // the turn errored. Reporting `stop` would tell the console the model
    // finished on its own, which is the reading that makes a truncated answer
    // look complete.
    expect(stored.messages[1]?.meta?.finishReason).toBe('error');
  });
});

/* ---- Routing and capability ---- */

describe('the model a turn is sent to', () => {
  it('asks the provider for the reasoning level the header chose', async () => {
    const { fetcher, calls } = responder(() =>
      sseResponse([chunk({ role: 'assistant', content: 'Hi' }), FINISH_FRAME, USAGE_FRAME].join('')),
    );
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h, { model: 'o3' });

    await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: { ...TURN, thinkingLevel: 'high' },
    });

    // `o3` declares reasoning, so the effort reaches the wire — in OpenAI's own
    // vocabulary, which is what the level was translated into.
    expect(calls[0]?.body.reasoning_effort).toBe('high');
  });

  it('sends no reasoning parameter to a model that cannot think', async () => {
    // `gpt-4o` has no reasoning flag, so the same degradation that drops an
    // image for a blind model drops the effort here rather than sending a
    // parameter the provider would answer with a 400.
    const { fetcher, calls } = responder(() =>
      sseResponse([chunk({ role: 'assistant', content: 'Hi' }), FINISH_FRAME, USAGE_FRAME].join('')),
    );
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: { ...TURN, thinkingLevel: 'high' },
    });

    expect(calls[0]?.body).not.toHaveProperty('reasoning_effort');
  });

  it('translates the level into Anthropic’s budget, with room above it', async () => {
    // The BYOK Messages manifest's own model is the anthropic-family one that
    // declares `reasoning`; none of the first-party Claude ids does, which is why
    // the level reaches the wire here and not there.
    const upstream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"internal-claude-sonnet","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const { fetcher, calls } = responder(() => sseResponse(upstream));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'byok-anthropic', credential: ANTHROPIC_KEY }],
    });
    const session = await newSession(h, {
      providerId: 'byok-anthropic',
      model: REASONING_ON_MESSAGES,
    });

    await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: { ...TURN, thinkingLevel: 'medium' },
    });

    const sent = calls[0]?.body as { thinking?: { budget_tokens?: number }; max_tokens?: number };
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    // Anthropic refuses a budget that is not below `max_tokens`, and the codec's
    // own default of 4096 is below every budget here.
    expect(sent.max_tokens).toBeGreaterThan(2048);
  });

  it('folds an image attachment into the request the model reads', async () => {
    const { fetcher, calls } = responder(() =>
      sseResponse([chunk({ role: 'assistant', content: 'I see it.' }), FINISH_FRAME, USAGE_FRAME].join('')),
    );
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: {
        ...TURN,
        attachments: [
          {
            id: 'att_1',
            kind: 'image',
            name: 'shot.png',
            mimeType: 'image/png',
            byteSize: 4,
            data: 'AAAA',
            width: 1,
            height: 1,
          },
        ],
      },
    });

    const sent = calls[0]?.body as { messages: { content: { type: string; image_url?: { url: string } }[] }[] };
    expect(sent.messages[0]?.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
  });

  it('refuses an oversize attachment before anything is written', async () => {
    // A turn the provider could never be sent is not a turn, and finding that
    // out after it is in the transcript would leave the session permanently
    // unable to answer — every later turn rebuilds its request from the same
    // attachment.
    const { fetcher, calls } = responder(() => sseResponse(''));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h);

    const response = await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: {
        ...TURN,
        attachments: [
          {
            id: 'att_1',
            kind: 'text',
            name: 'huge.log',
            mimeType: 'text/plain',
            byteSize: 1,
            data: 'x'.repeat(256 * 1024 + 1),
            width: null,
            height: null,
          },
        ],
      },
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/limit is/);
    expect(calls).toHaveLength(0);

    const stored = chatSessionSchema.parse(
      await (await call(h.app, sessionPath(session.id), { cookie: h.cookie })).json(),
    );
    expect(stored.messages).toEqual([]);
  });

  it('refuses a turn with no model chosen', async () => {
    // The console's "Provider default" placeholder is not a choice anybody made.
    // Answering with an aggregator's first model would put words in a model the
    // operator did not pick.
    const { fetcher } = responder(() => sseResponse(''));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h, { model: null });

    const response = await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: TURN,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/Choose a model/);
  });

  it('refuses an embedding model, which is not a chat turn at all', async () => {
    const { fetcher } = responder(() => sseResponse(''));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h, { model: 'text-embedding-3-large' });

    const response = await call(h.app, messagesPath(session.id), {
      method: 'POST',
      cookie: h.cookie,
      body: TURN,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/embedding model/);
  });

  it('reports a provider that has no account free as unavailable', async () => {
    // The console has no second candidate to fall back to, so a busy pool is a
    // message rather than a walk down a chain.
    const { fetcher } = responder(() => sseResponse(''));
    const h = await harness({ fetcher });

    const response = await call(h.app, messagesPath((await newSession(h)).id), {
      method: 'POST',
      cookie: h.cookie,
      body: TURN,
    });

    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toMatch(/No .* account/);
  });
});

/* ---- Export ---- */

describe('exporting a conversation', () => {
  it('answers a Markdown file named after the conversation', async () => {
    const upstream = [chunk({ role: 'assistant', content: 'The answer.' }), FINISH_FRAME, USAGE_FRAME].join('');
    const { fetcher } = responder(() => sseResponse(upstream));
    const h = await harness({
      fetcher,
      accounts: [{ providerId: 'openai', credential: OPENAI_KEY }],
    });
    const session = await newSession(h, { title: 'Refund policy!' });

    await call(h.app, messagesPath(session.id), { method: 'POST', cookie: h.cookie, body: TURN });

    const response = await call(h.app, exportPath(session.id), { cookie: h.cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    // A title is sanitised to letters, digits and dashes: it must not be able to
    // name a path or break the header.
    expect(response.headers.get('content-disposition')).toContain('filename="refund-policy.md"');

    const body = await response.text();
    expect(body).toContain('# Refund policy!');
    expect(body).toContain('## User');
    expect(body).toContain('Hi');
    expect(body).toContain('## Assistant');
    expect(body).toContain('The answer.');
  });
});
