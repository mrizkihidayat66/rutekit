import { createIdFactory } from '@shared';
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
  return { now: () => 1_700_000_000, ids, model };
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

      const encoded = codec.encodeRequest(canonical);

      // A path relative to the provider's base URL, and a body with something in
      // it — the two things every family has.
      expect(encoded.path.startsWith('/')).toBe(true);
      expect(encoded.path.length).toBeGreaterThan(1);
      expect(Object.keys(encoded.body).length).toBeGreaterThan(0);

      // The model reaches the provider *somewhere*, and where is the family's
      // business: three families put it in the body, and Google puts it in the
      // path (`/v1beta/models/gemini-1.5-pro:generateContent`) because that is
      // what Gemini's API does. Asserting the body specifically would have been
      // an assumption about one family's shape dressed up as a property of all
      // of them — which is exactly what this test caught the first time it ran.
      expect(`${encoded.path}${JSON.stringify(encoded.body)}`).toContain('gpt-4o');
    });

    it('decodes the family’s answer, or has no codec to decode with', () => {
      const codec = codecFor(family);

      if (codec === null) {
        expect(family).toBe('custom');
        return;
      }

      const result = codec.decodeResponse(PROVIDER_ANSWER[family], context());

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

      const result: CanonicalResult = codec.decodeResponse(PROVIDER_ANSWER[family], context());
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
