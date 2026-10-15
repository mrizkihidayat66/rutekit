import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import * as contracts from '../src/index.ts';

/**
 * A2 parity test. Two things must never drift:
 *
 *   1. Every exported type is exactly `z.infer` of its schema — if someone
 *      hand-writes an `interface` beside a schema, the compile-time assertions
 *      below stop matching and this file fails to typecheck.
 *   2. Every exported `*Schema` really is a runtime Zod schema (or one of the
 *      named factories), so nothing is exported as a "schema" that cannot
 *      validate anything.
 */

/**
 * Factories are functions returning a schema; everything else is a schema. There
 * are two kinds, told apart by what they are handed: `pageSchema` wraps one item
 * schema, while `updateSchema` takes a whole object shape. Both are named
 * `*Schema` and both must stay out of the "is this value a schema" sweep.
 */
const SCHEMA_FACTORIES = ['pageSchema'] as const;
const SHAPE_FACTORIES = ['updateSchema'] as const;
const FACTORIES: readonly string[] = [...SCHEMA_FACTORIES, ...SHAPE_FACTORIES];

const isZodSchema = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { safeParse?: unknown }).safeParse === 'function';

describe('contracts: schema <-> type parity', () => {
  it('exports every schema as a runtime Zod schema or a known factory', () => {
    const schemaExports = Object.entries(contracts).filter(([name]) => name.endsWith('Schema'));
    expect(schemaExports.length).toBeGreaterThan(50);

    const notSchemas = schemaExports
      .filter(([name]) => !FACTORIES.includes(name))
      .filter(([, value]) => !isZodSchema(value))
      .map(([name]) => name);

    expect(notSchemas).toEqual([]);
  });

  it('exports every declared factory as a callable returning a schema', () => {
    for (const name of SCHEMA_FACTORIES) {
      const factory = (contracts as Record<string, unknown>)[name];
      expect(typeof factory).toBe('function');
      const built = (factory as (item: z.ZodType) => unknown)(z.string());
      expect(isZodSchema(built)).toBe(true);
    }
  });

  it('exports every declared shape factory as a callable returning a schema', () => {
    for (const name of SHAPE_FACTORIES) {
      const factory = (contracts as Record<string, unknown>)[name];
      expect(typeof factory).toBe('function');
      const built = (factory as (shape: z.ZodRawShape) => unknown)({
        name: z.string(),
        tags: z.array(z.string()).default([]),
      });
      expect(isZodSchema(built)).toBe(true);
    }
  });

  it('has no orphan factories: each one is reachable from the barrel', () => {
    for (const name of FACTORIES) {
      expect(Object.keys(contracts)).toContain(name);
    }
  });
});

/**
 * Compile-time parity. Each assertion fails to typecheck the moment a type stops
 * being the inferred output of its schema — e.g. if it is replaced by a
 * hand-maintained interface that has quietly drifted.
 */
describe('contracts: derived types match their schemas', () => {
  it('keeps entity types derived from entity schemas', () => {
    expectTypeOf<contracts.Account>().toEqualTypeOf<z.infer<typeof contracts.accountSchema>>();
    expectTypeOf<contracts.AccountState>().toEqualTypeOf<
      z.infer<typeof contracts.accountStateSchema>
    >();
    expectTypeOf<contracts.ApiKey>().toEqualTypeOf<z.infer<typeof contracts.apiKeySchema>>();
    expectTypeOf<contracts.Asset>().toEqualTypeOf<z.infer<typeof contracts.assetSchema>>();
    expectTypeOf<contracts.GenerationJob>().toEqualTypeOf<
      z.infer<typeof contracts.generationJobSchema>
    >();
    expectTypeOf<contracts.BenchmarkRun>().toEqualTypeOf<
      z.infer<typeof contracts.benchmarkRunSchema>
    >();
    expectTypeOf<contracts.ChatSession>().toEqualTypeOf<z.infer<typeof contracts.chatSessionSchema>>();
    expectTypeOf<contracts.Job>().toEqualTypeOf<z.infer<typeof contracts.jobSchema>>();
    expectTypeOf<contracts.Provider>().toEqualTypeOf<z.infer<typeof contracts.providerSchema>>();
    expectTypeOf<contracts.Combo>().toEqualTypeOf<z.infer<typeof contracts.comboSchema>>();
    expectTypeOf<contracts.SystemStatus>().toEqualTypeOf<
      z.infer<typeof contracts.systemStatusSchema>
    >();
    expectTypeOf<contracts.LogEntry>().toEqualTypeOf<z.infer<typeof contracts.logEntrySchema>>();
    expectTypeOf<contracts.VerificationResult>().toEqualTypeOf<
      z.infer<typeof contracts.verificationResultSchema>
    >();
  });

  it('keeps canonical types derived from canonical schemas', () => {
    expectTypeOf<contracts.CanonicalMessage>().toEqualTypeOf<
      z.infer<typeof contracts.canonicalMessageSchema>
    >();
    expectTypeOf<contracts.ContentBlock>().toEqualTypeOf<
      z.infer<typeof contracts.contentBlockSchema>
    >();
    expectTypeOf<contracts.Usage>().toEqualTypeOf<z.infer<typeof contracts.usageSchema>>();
    expectTypeOf<contracts.ApiError>().toEqualTypeOf<z.infer<typeof contracts.apiErrorSchema>>();
  });

  it('keeps surface types derived from surface schemas', () => {
    expectTypeOf<contracts.ChatCompletionRequest>().toEqualTypeOf<
      z.infer<typeof contracts.chatCompletionRequestSchema>
    >();
    expectTypeOf<contracts.MessagesRequest>().toEqualTypeOf<
      z.infer<typeof contracts.messagesRequestSchema>
    >();
    expectTypeOf<contracts.ResponsesRequest>().toEqualTypeOf<
      z.infer<typeof contracts.responsesRequestSchema>
    >();
    expectTypeOf<contracts.CompletionRequest>().toEqualTypeOf<
      z.infer<typeof contracts.completionRequestSchema>
    >();
    expectTypeOf<contracts.ModelsResponse>().toEqualTypeOf<
      z.infer<typeof contracts.modelsResponseSchema>
    >();
  });

  it('keeps websocket types derived from websocket schemas', () => {
    expectTypeOf<contracts.WsClientMessage>().toEqualTypeOf<
      z.infer<typeof contracts.wsClientMessageSchema>
    >();
    expectTypeOf<contracts.WsServerMessage>().toEqualTypeOf<
      z.infer<typeof contracts.wsServerMessageSchema>
    >();
  });
});

/**
 * Invariants the rest of the system is allowed to assume. These encode product
 * decisions, so a change here should be a deliberate one.
 */
describe('contracts: encoded invariants', () => {
  it('exposes exactly the seven pool states, with disabled as a hard exclusion', () => {
    expect(contracts.accountStateSchema.options).toHaveLength(7);
    expect(contracts.accountStateSchema.options).toContain('disabled');

    for (const state of contracts.ROUTABLE_ACCOUNT_STATES) {
      expect(contracts.accountStateSchema.options).toContain(state);
    }
    // Routing may never pick from a non-routable state.
    expect(contracts.ROUTABLE_ACCOUNT_STATES).not.toContain('disabled');
    expect(contracts.ROUTABLE_ACCOUNT_STATES).not.toContain('banned');

    for (const state of contracts.RECOVERABLE_ACCOUNT_STATES) {
      expect(contracts.accountStateSchema.options).toContain(state);
    }
  });

  it('keeps time windows and their millisecond spans in step', () => {
    expect(contracts.TIME_WINDOWS).toEqual(contracts.timeWindowSchema.options);
    expect(contracts.TIME_WINDOWS).toContain('all');

    const fixed = contracts.TIME_WINDOWS.filter((window) => window !== 'all');
    expect(Object.keys(contracts.TIME_WINDOW_MS).sort()).toEqual([...fixed].sort());
  });

  it('uses the ComfyUI generation vocabulary, in order', () => {
    expect(contracts.generationJobStatusSchema.options).toEqual([
      'queued',
      'executing',
      'progress',
      'executed',
      'failed',
      'cancelled',
    ]);
  });

  it('offers all five client-facing API surfaces', () => {
    for (const surface of contracts.endpointStatusSchema.shape.surface.options) {
      expect(typeof surface).toBe('string');
    }
    expect(contracts.endpointStatusSchema.shape.surface.options).toEqual([
      'chat/completions',
      'messages',
      'responses',
      'completions',
      'models',
    ]);
  });

  it('opens every messages stream with message_start', () => {
    const eventTypes = contracts.messagesStreamEventSchema.options.map(
      (option) => option.shape.type.value,
    );
    expect(eventTypes[0]).toBe('message_start');
    expect(eventTypes).toContain('message_stop');
  });

  it('covers the real-time channels the dashboard subscribes to', () => {
    expect(contracts.wsChannelSchema.options).toEqual([
      'logs',
      'accounts',
      'jobs',
      'studio',
      'preview',
      'notifications',
      'system',
    ]);
  });

  it('keeps needs_manual distinct from failure', () => {
    expect(contracts.jobStatusSchema.options).toContain('needs_manual');
    expect(contracts.jobStatusSchema.options).not.toContain('needs_manual_failed');
  });
});

/**
 * Round-trip stability: parse(parse(x)) === parse(x). Catches refinements or
 * transforms that are not idempotent, which would make MSW fixtures and server
 * responses disagree after one extra pass.
 */
describe('contracts: round-trip stability', () => {
  const roundTrips: Array<[string, z.ZodType, unknown]> = [
    [
      'chat/completions request',
      contracts.chatCompletionRequestSchema,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] },
    ],
    [
      'chat/completions request keeps provider extras',
      contracts.chatCompletionRequestSchema,
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        // Not modelled by rutekit; must survive to a BYOK endpoint.
        parallel_tool_calls: true,
        custom_extension: { nested: [1, 2, 3] },
      },
    ],
    [
      'chat/completions response',
      contracts.chatCompletionResponseSchema,
      {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1_760_000_000,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hi there', reasoning_content: 'thought' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ],
    [
      'messages request',
      contracts.messagesRequestSchema,
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
      },
    ],
    [
      'messages response',
      contracts.messagesResponseSchema,
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    ],
    [
      'responses request',
      contracts.responsesRequestSchema,
      { model: 'gpt-5', input: 'hello' },
    ],
    [
      'responses response',
      contracts.responsesResponseSchema,
      {
        id: 'resp_1',
        object: 'response',
        created_at: 1_760_000_000,
        status: 'completed',
        model: 'gpt-5',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'hi' }],
          },
        ],
        output_text: 'hi',
        usage: null,
        previous_response_id: null,
      },
    ],
    [
      'completions request',
      contracts.completionRequestSchema,
      { model: 'gpt-3.5-turbo-instruct', prompt: 'once upon a time' },
    ],
    [
      'completions response',
      contracts.completionResponseSchema,
      {
        id: 'cmpl_1',
        object: 'text_completion',
        created: 1_760_000_000,
        model: 'gpt-3.5-turbo-instruct',
        choices: [{ index: 0, text: ' there was', finish_reason: 'stop' }],
      },
    ],
    [
      'models response',
      contracts.modelsResponseSchema,
      {
        object: 'list',
        data: [
          {
            id: 'gpt-4o',
            object: 'model',
            created: 1_760_000_000,
            owned_by: 'openai',
            rutekit: {
              providerId: 'openai',
              alias: null,
              contextWindow: 128_000,
              capabilities: { vision: true, tools: true, reasoning: false, embedding: false },
            },
          },
        ],
      },
    ],
    [
      'ws subscribe',
      contracts.wsClientMessageSchema,
      { type: 'subscribe', channels: ['logs', 'accounts'] },
    ],
    [
      'ws manual captcha input',
      contracts.wsClientMessageSchema,
      { type: 'manual_input', jobId: 'job_1', workerId: 'w_1', solution: 'AB12C', skipped: false },
    ],
    [
      'ws needs-manual push',
      contracts.wsServerMessageSchema,
      {
        type: 'job_needs_manual',
        jobId: 'job_1',
        workerId: 'w_1',
        itemId: 'item_1',
        reason: 'image challenge',
        screenshotUrl: null,
        manualDeadlineAt: '2026-10-11T09:05:00Z',
      },
    ],
    [
      'ws hello',
      contracts.wsServerMessageSchema,
      {
        type: 'hello',
        connectionId: 'c_1',
        channels: ['logs'],
        heartbeatSeconds: 30,
        serverTimeUtc: '2026-10-11T09:00:00Z',
      },
    ],
  ];

  it.each(roundTrips)('%s parses and is idempotent', (_name, schema, input) => {
    const once = schema.parse(input);
    const twice = schema.parse(once);
    expect(twice).toEqual(once);
  });
});
