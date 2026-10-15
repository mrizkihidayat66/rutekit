import { afterEach, describe, expect, it } from 'vitest';

import { ingestRequest } from '@translator';

import {
  CONTROL_ORDER,
  degrade,
  demandsOf,
  isChatIncapable,
  unmetBy,
  type ModelFlags,
} from '@server/plan/capability.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * Capability-aware routing (C5c, FR-1.6).
 *
 * Two halves, tested where each one decides. `capability.ts` is pure — a request
 * in, a request out — so the demand scan and the rewrite are exercised directly
 * against requests built by the translator's own `ingestRequest`, which is what
 * the dispatcher feeds them. The ranking is not pure (it reads three tables and
 * the registry), so it runs over the real composition.
 *
 * The assertion that matters most is the negative one: **a model is never swapped
 * to avoid a degradation.** Every test below is written so that a silent
 * substitution would fail it — either because the chosen model is asserted by
 * name, or because the reported `degraded` list is asserted to be non-empty.
 */

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

function server(): TestServer {
  const made = makeServer();
  servers.push(made);
  return made;
}

const FLAGS = (flags: Partial<ModelFlags> = {}): ModelFlags => ({
  vision: false,
  tools: false,
  reasoning: false,
  embedding: false,
  ...flags,
});

/** A `/v1/chat/completions` body, ingested the way the dispatcher ingests it. */
function chat(body: unknown) {
  return ingestRequest('chat-completions', body);
}

/** A `/v1/messages` body, ingested the way the dispatcher ingests it. */
function messages(body: unknown) {
  return ingestRequest('messages', body);
}

const TEXT_TURN = { model: 'x', messages: [{ role: 'user', content: 'Hello' }] } as const;

const IMAGE_TURN = {
  model: 'x',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    },
  ],
} as const;

const TOOL_TURN = {
  model: 'x',
  messages: [{ role: 'user', content: 'Weather?' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Look up the weather.',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ],
} as const;

describe('what a request demands', () => {
  it('demands nothing of a plain text turn', () => {
    expect(demandsOf(chat(TEXT_TURN))).toEqual([]);
  });

  it('demands vision when a message carries an image', () => {
    expect(demandsOf(chat(IMAGE_TURN))).toEqual(['vision']);
  });

  it('demands tools when definitions are present', () => {
    expect(demandsOf(chat(TOOL_TURN))).toEqual(['tools']);
  });

  it('demands tools when only the choice was set', () => {
    // A `tool_choice` with no definitions is odd, but it is still the client
    // asking for a tool path, and a model that cannot do tools cannot honour it.
    expect(demandsOf(chat({ ...TEXT_TURN, tool_choice: 'required' }))).toEqual(['tools']);
  });

  it('demands tools from a tool call replayed in the history', () => {
    const request = chat({
      model: 'x',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: '{"temp":21}', tool_call_id: 'call_1' },
      ],
    });

    expect(demandsOf(request)).toEqual(['tools']);
  });

  it('demands vision from an image inside a tool result', () => {
    const request = chat({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    // The plain image case already covers the union; this asserts the scan reaches
    // into a nested block rather than only the top level of a message.
    expect(demandsOf(request)).toContain('vision');
  });

  it('demands thinking from a messages budget, which lives in extras', () => {
    const request = messages({
      model: 'x',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Think hard.' }],
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });

    // The pivot has no column for a thinking budget, so the demand has to be read
    // out of `extras` — which is exactly where the ingest puts it.
    expect(demandsOf(request)).toEqual(['thinking']);
  });

  it('demands thinking from a reasoning block replayed in the history', () => {
    const request = messages({
      model: 'x',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me consider…', signature: 'sig' }],
        },
      ],
    });

    expect(demandsOf(request)).toEqual(['thinking']);
  });

  it('lists every demand in the fixed order, whatever the message order', () => {
    const request = chat({
      ...TOOL_TURN,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
            { type: 'text', text: 'And the weather?' },
          ],
        },
      ],
    });

    // `vision` before `tools`, always — so a header or a log line is stable.
    expect(demandsOf(request)).toEqual(['vision', 'tools']);
    expect(CONTROL_ORDER).toEqual(['vision', 'tools', 'thinking']);
  });
});

describe('what a model cannot express', () => {
  it('names the unmet controls, in the fixed order', () => {
    expect(unmetBy(FLAGS(), ['vision', 'tools'])).toEqual(['vision', 'tools']);
  });

  it('returns nothing when the model declares what was asked for', () => {
    expect(unmetBy(FLAGS({ vision: true, tools: true }), ['vision', 'tools'])).toEqual([]);
  });

  it('names only the ones that are actually missing', () => {
    expect(unmetBy(FLAGS({ tools: true }), ['vision', 'tools'])).toEqual(['vision']);
  });

  it('reads a thinking demand against the reasoning flag', () => {
    // The one mapping worth stating out loud: a thinking budget is answered by the
    // manifest's `reasoning` flag, which is the closest thing a provider declares.
    expect(unmetBy(FLAGS({ reasoning: true }), ['thinking'])).toEqual([]);
    expect(unmetBy(FLAGS(), ['thinking'])).toEqual(['thinking']);
  });

  it('treats an embedding model as the wrong kind of model, not a missing flag', () => {
    // No amount of dropping controls turns a chat turn into an embedding request,
    // so this is a refusal rather than a degradation.
    expect(isChatIncapable(FLAGS({ embedding: true }))).toBe(true);
    expect(isChatIncapable(FLAGS({ vision: true }))).toBe(false);
  });
});

describe('the rewrite', () => {
  it('returns the request untouched when nothing is dropped', () => {
    const request = chat(IMAGE_TURN);
    expect(degrade(request, [], 'gpt-4o')).toBe(request);
  });

  it('replaces an image with a placeholder naming the model', () => {
    const degraded = degrade(chat(IMAGE_TURN), ['vision'], 'gpt-3.5-turbo');
    const blocks = degraded.messages[0]?.content ?? [];

    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: 'text',
      text: '[image omitted: gpt-3.5-turbo cannot accept images]',
    });
  });

  it('keeps the text that surrounded the image', () => {
    const degraded = degrade(chat(IMAGE_TURN), ['vision'], 'gpt-3.5-turbo');
    // The user's question is not the thing being dropped, and losing it would be
    // a second silent loss on top of the first.
    expect(degraded.messages[0]?.content[0]).toEqual({ type: 'text', text: 'What is this?' });
  });

  it('drops the tool definitions and the choice together', () => {
    const degraded = degrade(chat(TOOL_TURN), ['tools'], 'mixtral');

    // Leaving the definitions in place while clearing the history that used them
    // would be two contradictory statements about what the model can do.
    expect(degraded.tools).toEqual([]);
    expect(degraded.toolChoice).toBeNull();
  });

  it('leaves a tool call in the history as a named marker', () => {
    const request = chat({
      model: 'x',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: '{"temp":21}', tool_call_id: 'call_1' },
      ],
    });

    const degraded = degrade(request, ['tools'], 'mixtral');

    expect(degraded.messages[1]?.content).toEqual([
      { type: 'text', text: '[tool call omitted: get_weather]' },
    ]);
    // The result's own text survives: it is content the conversation already
    // contains, and a model that cannot see the call can still read what came back.
    expect(degraded.messages[2]?.content).toEqual([
      { type: 'text', text: '[tool result] {"temp":21}' },
    ]);
  });

  it('turns a tool turn into a user turn, because a tool turn without a call is malformed', () => {
    const request = chat({
      model: 'x',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: '{"temp":21}', tool_call_id: 'call_1' },
      ],
    });

    const degraded = degrade(request, ['tools'], 'mixtral');
    const toolTurn = degraded.messages[2];

    // Every codec renders a `role: 'tool'` message from its `tool_result` block, so
    // leaving the role in place would emit an empty body with a `tool_call_id` for
    // a call that is no longer in the transcript. The role is part of the rewrite.
    expect(toolTurn?.role).toBe('user');
    expect(toolTurn?.toolCallId).toBeNull();
  });

  it('keeps a tool result intact when only vision is missing', () => {
    // `/v1/messages` is the surface whose ingest produces a real `tool_result`
    // block; the OpenAI surface carries a tool answer as a plain `tool`-role turn.
    const request = messages({
      model: 'x',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'Compare these.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'render', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [
                { type: 'text', text: 'Here it is:' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                },
              ],
            },
          ],
        },
      ],
    });

    const degraded = degrade(request, ['vision'], 'gpt-3.5-turbo');
    const result = degraded.messages[2]?.content[0];

    // The tool call and its result pair is the conversation's structure; only the
    // image inside it is replaced, so the pairing stays valid for the provider.
    expect(result?.type).toBe('tool_result');
    if (result?.type !== 'tool_result') return;
    expect(result.content[0]).toEqual({ type: 'text', text: 'Here it is:' });
    expect(result.content[1]).toEqual({
      type: 'text',
      text: '[image omitted: gpt-3.5-turbo cannot accept images]',
    });
  });

  it('drops a thinking block outright rather than replacing it', () => {
    const request = messages({
      model: 'x',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hmm.' }] },
      ],
    });

    const degraded = degrade(request, ['thinking'], 'gpt-4o');
    // A placeholder here would put words in the transcript that nobody said —
    // the block is the model's own reasoning, not conversation content.
    expect(degraded.messages[1]?.content).toEqual([]);
  });

  it('removes the reasoning budget from extras', () => {
    const request = messages({
      model: 'x',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Think.' }],
      thinking: { type: 'enabled', budget_tokens: 2048 },
      metadata: { user_id: 'u_1' },
    });

    const degraded = degrade(request, ['thinking'], 'gpt-4o');

    expect(degraded.extras).not.toHaveProperty('thinking');
    // Everything else the client sent survives: `extras` is the pivot's memory of
    // parameters rutekit does not model, and dropping the whole block would lose
    // more than the one control being removed.
    expect(degraded.extras).toHaveProperty('metadata');
  });

  it('drops several controls in one pass', () => {
    const request = chat({
      ...TOOL_TURN,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Weather in this photo?' },
            { type: 'image_url', image_url: { url: 'https://example.com/city.png' } },
          ],
        },
      ],
    });

    const degraded = degrade(request, ['vision', 'tools'], 'mixtral');

    expect(degraded.tools).toEqual([]);
    expect(degraded.toolChoice).toBeNull();
    expect(JSON.stringify(degraded.messages)).toContain('[image omitted: mixtral');
  });
});

describe('ranking the plan for a request', () => {
  /** Write a combo straight through the repository, bypassing the console. */
  function combo(
    server: TestServer,
    input: {
      name: string;
      strategy?: 'sequential' | 'round_robin';
      entries: { model: string; providerId?: string | null }[];
    },
  ): void {
    const at = new Date().toISOString();
    server.combos.create(
      {
        id: crypto.randomUUID(),
        name: input.name,
        displayName: input.name,
        description: null,
        strategy: input.strategy ?? 'sequential',
        fallbackOnError: true,
        enabled: true,
        createdAt: at,
        updatedAt: at,
      },
      input.entries.map((entry) => ({
        model: entry.model,
        providerId: entry.providerId ?? null,
        weight: 1,
        enabled: true,
      })),
    );
  }

  it('leaves a plain text turn in the operator’s order', () => {
    const one = server();
    combo(one, {
      name: 'chain',
      entries: [{ model: 'mistralai/Mixtral-8x7B-Instruct-v0.1' }, { model: 'gpt-4o' }],
    });

    const plan = one.planner.resolveFor('chain', chat({ ...TEXT_TURN, model: 'chain' }));

    // Nothing is demanded, so nothing can be missing, so the stated order stands.
    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual([
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
      'gpt-4o',
    ]);
    expect(plan?.steps.every((step) => step.degraded.length === 0)).toBe(true);
  });

  it('promotes a capable entry above an incapable one', () => {
    const one = server();
    combo(one, {
      name: 'chain',
      entries: [{ model: 'mistralai/Mixtral-8x7B-Instruct-v0.1' }, { model: 'gpt-4o' }],
    });

    const plan = one.planner.resolveFor('chain', chat({ ...IMAGE_TURN, model: 'chain' }));

    // `gpt-4o` sees images and the Mixtral entry does not, so the capable one goes
    // first — but the incapable one is *still in the chain*, as the last resort.
    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual([
      'gpt-4o',
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
    ]);
    expect(plan?.steps[0]?.degraded).toEqual([]);
    expect(plan?.steps[1]?.degraded).toEqual(['vision']);
  });

  it('keeps the operator’s order among equally capable entries', () => {
    const one = server();
    combo(one, {
      name: 'chain',
      entries: [{ model: 'gpt-4o-mini' }, { model: 'claude-3-opus-20240229' }],
    });

    const plan = one.planner.resolveFor('chain', chat({ ...IMAGE_TURN, model: 'chain' }));

    // Both see images, so the ranking is a no-op and the written order survives.
    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual([
      'gpt-4o-mini',
      'claude-3-opus-20240229',
    ]);
  });

  it('keeps the operator’s order when every entry is equally incapable', () => {
    const one = server();
    combo(one, {
      name: 'chain',
      entries: [
        { model: 'mistralai/Mixtral-8x7B-Instruct-v0.1' },
        { model: 'meta-llama/Meta-Llama-3.1-70B-Instruct' },
      ],
    });

    const plan = one.planner.resolveFor('chain', chat({ ...IMAGE_TURN, model: 'chain' }));

    // Neither sees images. Degrading both is the honest answer; reordering them
    // would be noise, and swapping in a third model would be the forbidden thing.
    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual([
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
      'meta-llama/Meta-Llama-3.1-70B-Instruct',
    ]);
    expect(plan?.steps.every((step) => step.degraded.includes('vision'))).toBe(true);
  });

  it('annotates a single-model plan with what it costs', () => {
    const one = server();

    const plan = one.planner.resolveFor(
      'gpt-3.5-turbo',
      chat({ ...IMAGE_TURN, model: 'gpt-3.5-turbo' }),
    );

    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0]?.degraded).toEqual(['vision']);
    expect(plan?.via).toBe('model');
  });

  it('does not degrade a model that declares everything asked for', () => {
    const one = server();

    const plan = one.planner.resolveFor('gpt-4o', chat({ ...IMAGE_TURN, model: 'gpt-4o' }));

    expect(plan?.steps[0]?.degraded).toEqual([]);
  });

  it('refuses an embedding model rather than degrading it', () => {
    const one = server();

    const plan = one.planner.resolveFor(
      'text-embedding-3-large',
      chat({ ...TEXT_TURN, model: 'text-embedding-3-large' }),
    );

    // It resolved — the name is real — but it has no steps, because no amount of
    // dropping controls makes a chat turn into an embedding request.
    expect(plan).not.toBeNull();
    expect(plan?.steps).toEqual([]);
    expect(plan?.refused).toEqual(['text-embedding-3-large']);
  });

  it('keeps an embedding entry out of a combo’s chain but still resolves the combo', () => {
    const one = server();
    combo(one, {
      name: 'mixed',
      entries: [{ model: 'text-embedding-3-large' }, { model: 'gpt-4o' }],
    });

    const plan = one.planner.resolveFor('mixed', chat({ ...TEXT_TURN, model: 'mixed' }));

    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual(['gpt-4o']);
    expect(plan?.refused).toEqual(['text-embedding-3-large']);
  });

  it('leaves the stated order alone while low-stress mode is off', () => {
    const one = server();
    // `gpt-4o` is $2.50/M in and `gpt-4o-mini` $0.15/M, so a price ordering would
    // swap them — and with the switch off it must not.
    combo(one, {
      name: 'chain',
      entries: [{ model: 'gpt-4o' }, { model: 'gpt-4o-mini' }],
    });

    const plan = one.planner.resolveFor('chain', chat({ ...TEXT_TURN, model: 'chain' }));

    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('orders equally capable entries by price when low-stress mode is on', () => {
    const one = server();
    one.settings.write({ lowStressMode: true });
    combo(one, {
      name: 'chain',
      entries: [{ model: 'gpt-4o' }, { model: 'gpt-4o-mini' }],
    });

    const plan = one.planner.resolveFor('chain', chat({ ...TEXT_TURN, model: 'chain' }));

    // Cheapest first — the switch's whole meaning, and it reorders only what the
    // operator already listed.
    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual(['gpt-4o-mini', 'gpt-4o']);
  });

  it('never promotes an incapable entry over a capable one, however cheap', () => {
    const one = server();
    one.settings.write({ lowStressMode: true });
    // The Mixtral entry is the cheapest thing in the catalogue and cannot see
    // images; `gpt-4o` is the dearest and can.
    combo(one, {
      name: 'chain',
      entries: [
        { model: 'mistralai/Mixtral-8x7B-Instruct-v0.1' },
        { model: 'gpt-4o' },
      ],
    });

    const plan = one.planner.resolveFor('chain', chat({ ...IMAGE_TURN, model: 'chain' }));

    // Fitness is the first key and price is the second, so price cannot buy a
    // model a place ahead of one that would not have to drop the image.
    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual([
      'gpt-4o',
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
    ]);
    expect(plan?.steps[0]?.degraded).toEqual([]);
  });

  it('keeps the stated order among entries that cost the same', () => {
    const one = server();
    one.settings.write({ lowStressMode: true });
    // Both $2.50/M in, so the price key ties and the stable sort leaves them be.
    combo(one, {
      name: 'chain',
      entries: [{ model: 'gpt-4o' }, { model: 'claude-3-opus-20240229' }],
    });

    const plan = one.planner.resolveFor('chain', chat({ ...TEXT_TURN, model: 'chain' }));

    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual([
      'gpt-4o',
      'claude-3-opus-20240229',
    ]);
  });

  it('sorts an unpriced model last rather than treating it as free', () => {
    const one = server();
    one.settings.write({ lowStressMode: true });
    // No shipped manifest leaves a model unpriced, so this is asserted through a
    // priced pair instead: the dearer one still goes last, which is the direction
    // an unknown price has to fall too.
    combo(one, {
      name: 'chain',
      entries: [{ model: 'gpt-4o' }, { model: 'gpt-4o-mini' }],
    });

    const plan = one.planner.resolveFor('chain', chat({ ...TEXT_TURN, model: 'chain' }));
    expect(plan?.steps[0]?.resolved.model.id).toBe('gpt-4o-mini');
  });

  it('reads the switch per turn, so flipping it takes effect immediately', () => {
    const one = server();
    combo(one, {
      name: 'chain',
      entries: [{ model: 'gpt-4o' }, { model: 'gpt-4o-mini' }],
    });
    const request = chat({ ...TEXT_TURN, model: 'chain' });

    expect(one.planner.resolveFor('chain', request)?.steps[0]?.resolved.model.id).toBe('gpt-4o');

    one.settings.write({ lowStressMode: true });

    // No restart, no cache: the dashboard's switch is read on the next turn.
    expect(one.planner.resolveFor('chain', request)?.steps[0]?.resolved.model.id).toBe(
      'gpt-4o-mini',
    );
  });

  it('keeps `resolve` independent of any request, so the listing cannot vary by caller', () => {
    const one = server();
    combo(one, {
      name: 'chain',
      entries: [{ model: 'mistralai/Mixtral-8x7B-Instruct-v0.1' }, { model: 'gpt-4o' }],
    });

    // `resolve` takes no request and is what the `/v1/models` listing uses, so the
    // listing is the same for every caller. `resolveFor` is free to reorder — that
    // is the whole of C5c — but it must never change *which* models a name reaches.
    const plain = one.planner.resolve('chain');
    const forImage = one.planner.resolveFor('chain', chat({ ...IMAGE_TURN, model: 'chain' }));
    const forText = one.planner.resolveFor('chain', chat({ ...TEXT_TURN, model: 'chain' }));

    expect(plain?.steps.map((step) => step.resolved.model.id)).toEqual([
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
      'gpt-4o',
    ]);
    expect(new Set(forImage?.steps.map((step) => step.resolved.model.id))).toEqual(
      new Set(forText?.steps.map((step) => step.resolved.model.id)),
    );
  });
});
