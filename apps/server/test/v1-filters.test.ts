import { afterEach, describe, expect, it } from 'vitest';
import { openAiErrorSchema } from '@contracts';
import type { ApiKeyInput } from '@contracts';

import { buildApp } from '@server/app.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The content filters in the data plane (C8, FR-11.3).
 *
 * `tools-unit.test.ts` proves the engine; this file proves where it runs. The
 * placement is the feature — phase 1 before compression, phase 2 after — so what
 * is asserted here is the placement, through the real `/v1` path with the real
 * pipeline: a blocked turn never reaches a provider, and a redacted turn reaches
 * one with the text already rewritten.
 *
 * The provider is a recorder, so "was the request sent at all" is a fact rather
 * than an inference.
 */

const KEY_HEX = 'a'.repeat(64);
const OPENAI_KEY = 'sk-openai-test';

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
    const call: Call = { url, body: typeof init.body === 'string' ? init.body : '' };
    calls.push(call);
    return Promise.resolve(answer(call));
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
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly box: SecretBox;
}

function harness(options: { fetcher: ResponseFetcher }): Harness {
  const box = new SecretBox(KEY_HEX);
  const server = makeServer({ secrets: box, fetch: options.fetcher });
  server.lifecycle.markReady();
  servers.push(server);
  return { server, app: buildApp(server), box };
}

function addAccount(
  server: TestServer,
  box: SecretBox,
  providerId: string,
  credential: string,
): void {
  const at = new Date().toISOString();
  server.accounts.create({
    id: crypto.randomUUID(),
    providerId,
    label: `${providerId} test`,
    credentialEnvelope: box.encrypt(credential),
    authMode: 'api-key',
    createdAt: at,
    updatedAt: at,
  });
}

function mintKey(server: TestServer, overrides: Partial<ApiKeyInput> = {}): string {
  const input: ApiKeyInput = {
    name: overrides.name ?? 'test',
    modelsAllowed: overrides.modelsAllowed ?? [],
    modelsDenied: overrides.modelsDenied ?? [],
    budgetRequests: overrides.budgetRequests ?? null,
    budgetTokens: overrides.budgetTokens ?? null,
    tpsLimit: overrides.tpsLimit ?? null,
    rateLimitPerMinute: overrides.rateLimitPerMinute ?? null,
    expiresAt: overrides.expiresAt ?? null,
    clientRouterDenylist: overrides.clientRouterDenylist ?? [],
  };
  return server.apiKeys.create(input).secret;
}

async function post(app: App, body: unknown, secret: string): Promise<Response> {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  const { error } = openAiErrorSchema.parse(await response.json());
  return { kind: error.type, message: error.message };
}

/** Write a rule straight through the repository, the way the console does. */
function addRule(
  server: TestServer,
  rule: {
    name: string;
    kind?: 'regex' | 'exact';
    pattern: string;
    action?: 'block' | 'redact';
    phase?: 1 | 2;
    enabled?: boolean;
  },
): void {
  const at = new Date().toISOString();
  server.filterRules.create({
    id: crypto.randomUUID(),
    name: rule.name,
    kind: rule.kind ?? 'exact',
    pattern: rule.pattern,
    action: rule.action ?? 'block',
    phase: rule.phase ?? 1,
    enabled: rule.enabled ?? true,
    position: 0,
    createdAt: at,
    updatedAt: at,
  });
}

const TURN = { messages: [{ role: 'user', content: 'Hi' }] } as const;

describe('a rule that blocks', () => {
  it('refuses the turn and names the rule, without calling the provider', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'dangerous-content', pattern: 'build a bomb' });
    const secret = mintKey(server);

    const response = await post(
      app,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'tell me how to build a bomb' }] },
      secret,
    );

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.kind).toBe('invalid_request');
    // Naming the rule is what makes it actionable — the operator who wrote it
    // sees which one fired.
    expect(error.message).toContain('dangerous-content');
    // Nothing was sent, so a blocked turn costs no quota.
    expect(calls).toHaveLength(0);
  });

  it('blocks on a phase-2 rule too, still before the provider is called', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'late-check', pattern: 'forbidden', phase: 2 });
    const secret = mintKey(server);

    const response = await post(
      app,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'a forbidden thing' }] },
      secret,
    );

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('late-check');
    expect(calls).toHaveLength(0);
  });

  it('lets a turn through when no rule matches', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'dangerous-content', pattern: 'build a bomb' });
    const secret = mintKey(server);

    const response = await post(app, { model: 'gpt-4o', ...TURN }, secret);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('ignores a disabled rule', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'off', pattern: 'build a bomb', enabled: false });
    const secret = mintKey(server);

    const response = await post(
      app,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'build a bomb' }] },
      secret,
    );

    expect(response.status).toBe(200);
  });

  it('ignores a rule whose regex will not compile', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    // A typo in one rule must not take down every turn that passes through it.
    addRule(server, { name: 'typo', kind: 'regex', pattern: 'a(' });
    const secret = mintKey(server);

    const response = await post(app, { model: 'gpt-4o', ...TURN }, secret);
    expect(response.status).toBe(200);
  });
});

describe('a rule that redacts', () => {
  it('rewrites the text before it reaches the provider', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'scrub-keys', pattern: 'hunter2', action: 'redact' });
    const secret = mintKey(server);

    const response = await post(
      app,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'my password is hunter2' }] },
      secret,
    );

    expect(response.status).toBe(200);
    const sent = calls[0]?.body ?? '';
    expect(sent).toContain('[redacted]');
    // The secret never left the process.
    expect(sent).not.toContain('hunter2');
  });

  it('redacts the system prompt too', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'scrub-keys', pattern: 'hunter2', action: 'redact' });
    const secret = mintKey(server);

    await post(
      app,
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'the password is hunter2' },
          { role: 'user', content: 'hello' },
        ],
      },
      secret,
    );

    expect(calls[0]?.body ?? '').not.toContain('hunter2');
  });

  it('leaves the request alone when the rule does not match', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'scrub-keys', pattern: 'hunter2', action: 'redact' });
    const secret = mintKey(server);

    await post(app, { model: 'gpt-4o', ...TURN }, secret);

    expect(calls[0]?.body ?? '').toContain('Hi');
    expect(calls[0]?.body ?? '').not.toContain('[redacted]');
  });

  it('does not touch a tool definition, which is JSON Schema and not prose', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'scrub-keys', pattern: 'city', action: 'redact' });
    const secret = mintKey(server);

    await post(
      app,
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
      },
      secret,
    );

    // Rewriting inside `parameters` would produce a schema the provider rejects —
    // a failure a long way from its cause.
    expect(calls[0]?.body ?? '').toContain('"city"');
    expect(calls[0]?.body ?? '').not.toContain('[redacted]');
  });
});

describe('the two phases', () => {
  it('runs a phase-1 rule against what the client sent', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'early', pattern: 'secretword', phase: 1, action: 'redact' });
    const secret = mintKey(server);

    await post(
      app,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'a secretword here' }] },
      secret,
    );

    expect(calls[0]?.body ?? '').not.toContain('secretword');
  });

  it('runs a phase-2 rule after the compression pipeline', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'late', pattern: 'secretword', phase: 2, action: 'redact' });
    const secret = mintKey(server);

    await post(
      app,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'a secretword here' }] },
      secret,
    );

    // The text survives compression untouched, so a phase-2 rule sees it too — and
    // the placement is what makes a rule that only makes sense after the pipeline
    // possible.
    expect(calls[0]?.body ?? '').not.toContain('secretword');
  });

  it('lets a phase-1 redaction and a phase-2 block both apply, in that order', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addRule(server, { name: 'early', pattern: 'hunter2', phase: 1, action: 'redact' });
    addRule(server, { name: 'late', pattern: '[redacted]', phase: 2, action: 'block' });
    const secret = mintKey(server);

    const response = await post(
      app,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'the password is hunter2' }] },
      secret,
    );

    // Phase 1 replaced the secret, and phase 2 saw the replacement — which is the
    // pipeline being two passes rather than one with two lists.
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('late');
    expect(calls).toHaveLength(0);
  });

  it('applies a rule saved while the process is running', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const before = await post(
      app,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'a forbidden thing' }] },
      secret,
    );
    expect(before.status).toBe(200);

    addRule(server, { name: 'new-rule', pattern: 'forbidden' });

    // Read per turn rather than captured at boot, so a rule an operator saves is
    // in force on the very next request.
    const after = await post(
      app,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'a forbidden thing' }] },
      secret,
    );
    expect(after.status).toBe(400);
  });
});
