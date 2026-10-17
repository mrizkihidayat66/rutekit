import { createIdFactory } from '@shared';

import { testCrypto } from './crypto-stand-in.ts';
import {
  chatCompletionResponseSchema,
  completionResponseSchema,
  messagesResponseSchema,
  responsesResponseSchema,
  wireFamilySchema,
  type WireFamily,
} from '@contracts';
import { describe, expect, it } from 'vitest';

import type { CanonicalResult } from '../src/canonical-result.ts';
import type { CodecContext } from '../src/codecs/types.ts';
import { chooseRoute } from '../src/route.ts';
import { clientSurfaceSchema, type ClientSurface } from '../src/surface.ts';
import { codecFor, ingestRequest, renderResult } from '../src/index.ts';
import { crc32 } from '../src/codecs/kiro-eventstream.ts';

/**
 * The whole matrix, swept (A1, ROADMAP D1).
 *
 * `codecs.test.ts`, `ingest.test.ts` and `render.test.ts` each assert a specific
 * behaviour: the field a provider insists on, the block a client reads back, the
 * one case where a finish reason is flattened. They are written by hand, case by
 * case, and that is what they are good at.
 *
 * What none of them can do is notice a *combination* nobody wrote a case for.
 * There are four client surfaces and four wire families, so sixteen pairs, and
 * the hand-written tests cover the ones someone thought of. Adding a fifth
 * surface or a new family would leave twelve or twenty untested pairs, and
 * nothing would fail — the suite would stay green while the new dialect was
 * never once driven end to end.
 *
 * So this file does not name a single pair. It enumerates the two enums and
 * sweeps every combination through the whole pipeline: ingest → route → encode →
 * decode → render, asserting at each step. A surface or family added later is
 * covered the moment it exists, which is the point (A1).
 *
 * The assertions are deliberately *structural* rather than about content. The
 * hand-written tests already own "what does this field mean"; what is missing is
 * "does every pair work at all", and the strongest available form of that is the
 * last step — the rendered body has to parse against the surface's own schema in
 * `packages/contracts`. That is what binds the translator to the contract: a
 * family that renders a body its own surface's schema rejects fails here, in the
 * package that produced it, rather than at the edge as a client error.
 */

const ids = createIdFactory((bytes) => new Uint8Array(bytes));

function context(model = 'gpt-4o'): CodecContext {
  // The account fields are for qoder, whose request signing carries the account's
  // own id and type — a codec that cannot sign refuses rather than sending a
  // request it knows will be rejected, so the matrix has to give it something to
  // sign with.
  return {
    now: () => 1_700_000_000,
    ids,
    model,
    account: {
      userId: 'user-1',
      userType: 'personal_standard',
      securityOauthToken: 'bearer-1',
      refreshToken: 'refresh-1',
      machineId: 'machine-1',
    },
    crypto: testCrypto,
  };
}

/**
 * One AWS EventStream frame, exactly as the wire spells one.
 *
 * Hand-built here rather than produced by the decoder under test: a fixture made
 * by the code it checks would prove only that the code is self-consistent. This
 * is the framing the format documents — lengths, CRCs, a string header, a JSON
 * payload — and the decoder has to agree with it.
 */
function eventStreamFrame(eventType: string, payload: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const name = encoder.encode(':event-type');
  const value = encoder.encode(eventType);
  const body = encoder.encode(JSON.stringify(payload));

  const headers = new Uint8Array(1 + name.length + 1 + 2 + value.length);
  let at = 0;
  headers[at++] = name.length;
  headers.set(name, at);
  at += name.length;
  headers[at++] = 7; // the string type
  headers[at++] = (value.length >> 8) & 0xff;
  headers[at++] = value.length & 0xff;
  headers.set(value, at);

  const total = 12 + headers.length + body.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  frame.set(headers, 12);
  frame.set(body, 12 + headers.length);
  // The CRCs are written as the format requires; the decoder reads past them, so
  // a wrong one here would be a fixture bug rather than a test failure.
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)));
  return frame;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A signed family's body, decoded back to text.
 *
 * qoder's body is a JSON document run through a rotation and a substitution, so
 * the model id is in there and not readable until the encoding is undone. This is
 * the inverse, written from the format rather than from the encoder — which is
 * also what makes the round trip evidence about the format.
 */
function decodeQoderBody(encoded: string): string {
  const custom = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const back = new Map<string, string>();
  for (let index = 0; index < 64; index += 1) back.set(custom[index] as string, standard[index] as string);
  back.set('$', '=');

  const rotated = [...encoded].map((character) => back.get(character) ?? '').join('');
  const length = rotated.length;
  const third = Math.floor(length / 3);
  const unrotated =
    rotated.slice(length - third) + rotated.slice(third, length - third) + rotated.slice(0, third);
  return Buffer.from(unrotated, 'base64').toString('utf8');
}

/** One qoder SSE body: an envelope whose `body` is the [OI] chunk as a string. */
function qoderEnvelope(chunk: unknown): Uint8Array {
  const frame = `data:${JSON.stringify({ headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify(chunk), statusCodeValue: 200, statusCode: 'OK' })}

`;
  return new TextEncoder().encode(frame);
}

/** A body as the codec now receives it: bytes, whichever family it belongs to. */
function bodyBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new TextEncoder().encode(JSON.stringify(value));
}

/** A minimal, valid body for each surface. The pivot is what these have in common. */
const MINIMAL_BODY: Readonly<Record<ClientSurface, unknown>> = {
  'chat-completions': {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  },
  messages: {
    model: 'gpt-4o',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  },
  responses: {
    model: 'gpt-4o',
    input: 'hi',
  },
  completions: {
    model: 'gpt-4o',
    prompt: 'hi',
  },
};

/**
 * A minimal answer in each family's own dialect.
 *
 * Hand-written per family rather than generated, because the point is to prove
 * the codec reads the *provider's* shape — a fixture built from the codec's own
 * expectations would prove only that it is self-consistent.
 */
const PROVIDER_ANSWER: Readonly<Record<WireFamily, unknown>> = {
  openai: {
    id: 'chatcmpl-1',
    model: 'gpt-4o',
    created: 1_700_000_000,
    choices: [
      { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  },
  anthropic: {
    id: 'msg_1',
    model: 'claude-sonnet-4',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  },
  google: {
    modelVersion: 'gemini-1.5-pro',
    candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  },
  // No codec, so no answer to read. Present so the record is exhaustive over the
  // enum and a family added later is a type error here until it has a fixture.
  // kiro's answer is not text at all: AWS EventStream frames, built here by hand
  // so the fixture is the wire rather than the codec's own output. Two of them,
  // because this wire reports the text and the usage in separate events — which
  // is also why the decoder assembles usage across the whole stream.
  kiro: concatBytes(
    eventStreamFrame('assistantResponseEvent', { content: 'hello' }),
    eventStreamFrame('meteringEvent', { usage: { inputTokens: 3, outputTokens: 2 } }),
  ),
  // qoder's answer is [OI] chunks inside an envelope of its own: the frame's
  // `data` is an object whose `body` is the chunk as a string. Built here so the
  // fixture is the wire, not the codec's own output.
  // Two frames, because this wire reports the text and the usage separately —
  // the same arrangement kiro has, and for the same reason: a metering event is
  // its own message.
  qoder: concatBytes(
    qoderEnvelope({ id: 'chatcmpl-1', model: 'lite', created: 1_700_000_000, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' } }] }),
    qoderEnvelope({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
  ),
  custom: null,
};

/** The response schema each surface promises, for the final check. */
const SURFACE_RESPONSE_SCHEMA: Readonly<
  Record<ClientSurface, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }>
> = {
  'chat-completions': chatCompletionResponseSchema,
  messages: messagesResponseSchema,
  responses: responsesResponseSchema,
  completions: completionResponseSchema,
};

const SURFACES: readonly ClientSurface[] = clientSurfaceSchema.options;
const FAMILIES: readonly WireFamily[] = wireFamilySchema.options;

/**
 * Every pair, as a table. Vitest prints the label on failure, so a broken
 * combination names itself rather than arriving as an anonymous index.
 */
const PAIRS: readonly { surface: ClientSurface; family: WireFamily }[] = SURFACES.flatMap(
  (surface) => FAMILIES.map((family) => ({ surface, family })),
);

describe('the surface × family matrix', () => {
  it('sweeps every combination, and there are as many as the enums say', () => {
    // If the enumeration ever silently emptied, every assertion below would pass
    // by doing nothing.
    expect(SURFACES.length).toBeGreaterThan(0);
    expect(FAMILIES.length).toBeGreaterThan(0);
    expect(PAIRS).toHaveLength(SURFACES.length * FAMILIES.length);
  });

  describe.each(PAIRS)('$surface → $family', ({ surface, family }) => {
    it('pivots the client body into a canonical request', () => {
      const canonical = ingestRequest(surface, MINIMAL_BODY[surface]);

      expect(canonical.model).toBe('gpt-4o');
      expect(canonical.messages.length).toBeGreaterThan(0);
      // The user's text survives the pivot whatever the surface called it: a
      // string, a part list, or a bare prompt.
      expect(JSON.stringify(canonical.messages)).toContain('hi');
    });

    it('decides a route for the pair, and the decision is one of the two', () => {
      expect(['direct', 'pivot']).toContain(chooseRoute(surface, family));
    });

    it('encodes the pivot into the family’s wire, or has no codec at all', () => {
      const codec = codecFor(family);
      const canonical = ingestRequest(surface, MINIMAL_BODY[surface]);

      if (codec === null) {
        // `custom` is the only family without one, and that is the honest
        // answer: a wire rutekit does not know cannot be reached through `/v1`.
        expect(family).toBe('custom');
        return;
      }

      const encoded = codec.encodeRequest(canonical, context());

      // A path relative to the provider's base URL, and a body with something in
      // it — the two things every family has. A body may be an encoded string
      // rather than an object, because a wire that signs its body sends the
      // bytes it signed; either way it has to be non-empty.
      expect(encoded.path.startsWith('/')).toBe(true);
      expect(encoded.path.length).toBeGreaterThan(1);
      const bodyLength =
        typeof encoded.body === 'string' ? encoded.body.length : Object.keys(encoded.body).length;
      expect(bodyLength).toBeGreaterThan(0);

      // The model reaches the provider *somewhere*, and where is the family's
      // business: three families put it in the body, and Google puts it in the
      // path (`/v1beta/models/gemini-1.5-pro:generateContent`) because that is
      // what Gemini's API does. Asserting the body specifically would have been
      // an assumption about one family's shape dressed up as a property of all
      // of them — which is exactly what this test caught the first time it ran.
      // The model reaches the provider *somewhere*, and where is the family's
      // business. Three put it in the body, Google puts it in the path, and a
      // signed family puts it in a body that is not readable until it is decoded
      // — so a family that encodes its body is asked to decode it rather than
      // being failed for not being legible.
      const readable =
        typeof encoded.body === 'string'
          ? decodeQoderBody(encoded.body)
          : JSON.stringify(encoded.body);
      const searchable = `${encoded.path}${readable}${JSON.stringify(encoded.headers ?? {})}`;
      expect(searchable).toContain('gpt-4o');
    });

    it('decodes the family’s answer, or has no codec to decode with', () => {
      const codec = codecFor(family);

      if (codec === null) {
        expect(family).toBe('custom');
        return;
      }

      const result = codec.decodeResponse(bodyBytes(PROVIDER_ANSWER[family]), context());

      // The pivot's own shape, whichever dialect it came out of.
      expect(result.model.length).toBeGreaterThan(0);
      expect(result.message.role).toBe('assistant');
      expect(result.message.content.length).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBeGreaterThan(0);
    });

    it('renders a body the surface’s own contract accepts', () => {
      // The step that binds this package to `packages/contracts`: whatever the
      // family was, the client gets a body its surface promises. A family that
      // rendered something its own schema rejects fails here rather than at the
      // edge, where it would arrive as an unexplained client error.
      const codec = codecFor(family);
      if (codec === null) {
        expect(family).toBe('custom');
        return;
      }

      const result: CanonicalResult = codec.decodeResponse(bodyBytes(PROVIDER_ANSWER[family]), context());
      const rendered = renderResult(surface, result);
      const parsed = SURFACE_RESPONSE_SCHEMA[surface].safeParse(rendered);

      expect(parsed.success, `${surface} rejected what ${family} rendered`).toBe(true);
    });
  });

  it('names a direct route only for the two pairs that have one', () => {
    // The route table read off the matrix rather than asserted pair by pair, so
    // a family added later cannot quietly acquire a direct route.
    const direct = PAIRS.filter(({ surface, family }) => chooseRoute(surface, family) === 'direct');

    expect(direct).toEqual([
      { surface: 'chat-completions', family: 'openai' },
      { surface: 'messages', family: 'anthropic' },
    ]);
  });

  it('has a codec for every family except custom', () => {
    const missing = FAMILIES.filter((family) => codecFor(family) === null);
    expect(missing).toEqual(['custom']);
  });
});
