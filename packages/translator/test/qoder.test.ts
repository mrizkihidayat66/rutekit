import { createIdFactory } from '@shared';
import { describe, expect, it } from 'vitest';

import type { CanonicalRequest } from '../src/canonical-request.ts';
import type { CodecContext } from '../src/codecs/types.ts';
import {
  decodeQoderResponse,
  encodeQoderRequest,
  qoderError,
  renewQoderCredential,
} from '../src/codecs/qoder.ts';
import { createQoderStreamDecoder } from '../src/codecs/qoder.ts';
import { testCrypto } from './crypto-stand-in.ts';

/**
 * qoder's wire: the signing, the envelope, and the chunks inside it.
 *
 * Three things here are worth more than the rest.
 *
 * **The payload encoding is checked against a second implementation.** The body
 * goes through a rotation and a substitution, and a test that only ran the
 * encoder would prove it is self-consistent and nothing else. The decoder below
 * is written from the format rather than from the encoder, so the two agreeing is
 * evidence about the format.
 *
 * **The envelope is hand-built**, like kiro's frames: `data` is an object whose
 * `body` is a chunk as a string, and the codec has to take that apart before the
 * [OI] decoder can read it.
 *
 * **The signing is exercised through the stand-in port**, which is the reason the
 * port exists: the codec's structure is what is under test, and the real
 * primitives are verified against the live provider rather than against a
 * constant in a test.
 */

const ids = createIdFactory((bytes) => new Uint8Array(bytes));

function context(account: Readonly<Record<string, string>> = {}): CodecContext {
  return {
    now: () => 1_700_000_000,
    ids,
    model: 'lite',
    account: {
      userId: 'user-1',
      userType: 'personal_standard',
      securityOauthToken: 'bearer-1',
      refreshToken: 'refresh-1',
      ...account,
    },
    crypto: testCrypto,
  };
}

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The payload decoder, written from the format rather than from the encoder.
 *
 * The inverse of the rotation is applied in the opposite order, and the alphabet
 * maps back. If the encoder and this disagree, one of them is wrong about the
 * format — which is the only thing a round-trip test can actually establish.
 */
function decodePayload(encoded: string): string {
  const back = new Map<string, string>();
  for (let index = 0; index < 64; index += 1) {
    back.set(CUSTOM_ALPHABET[index] as string, STANDARD_ALPHABET[index] as string);
  }
  back.set('$', '=');

  const rotated = [...encoded].map((character) => back.get(character) ?? '').join('');
  const length = rotated.length;
  const third = Math.floor(length / 3);

  // The encoder writes `C + B + A`, where the original is `A + B + C` and the
  // three pieces are the first third, the middle, and the last third. Undoing it
  // is therefore `A + B + C` read back off those same offsets — and getting this
  // order wrong is the mistake the round trip exists to catch.
  const unrotated =
    rotated.slice(length - third) + rotated.slice(third, length - third) + rotated.slice(0, third);

  return Buffer.from(unrotated, 'base64').toString('utf8');
}

const request: CanonicalRequest = {
  model: 'lite',
  system: [{ type: 'text', text: 'be brief' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }], name: null, toolCallId: null }],
  sampling: {
    temperature: null,
    topP: null,
    topK: null,
    maxTokens: null,
    stop: [],
    seed: null,
    presencePenalty: null,
    frequencyPenalty: null,
  },
  tools: [],
  toolChoice: null,
  responseFormat: null,
  stream: true,
  extras: {},
};

/** One frame of qoder's stream: an envelope whose body is a chunk as a string. */
function envelope(chunk: unknown, status = 200): string {
  return `data:${JSON.stringify({
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(chunk),
    statusCodeValue: status,
    statusCode: status === 200 ? 'OK' : 'FORBIDDEN',
  })}\n\n`;
}

describe('the request', () => {
  it('sends an encoded body rather than the JSON the pivot holds', () => {
    const encoded = encodeQoderRequest(request, context());

    // A string, because the body was signed and the bytes that were signed are
    // the bytes that must leave — re-serialising would produce a different string
    // and a signature that does not match it.
    expect(typeof encoded.body).toBe('string');
    expect(decodePayload(encoded.body as string)).toContain('"model_config"');
  });

  it('round-trips through an independent decoder', () => {
    const encoded = encodeQoderRequest(request, context());
    const decoded = JSON.parse(decodePayload(encoded.body as string)) as Record<string, unknown>;

    // The conversation survived, which is what the encoding is for.
    expect(decoded['messages']).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'ping' },
    ]);
    expect((decoded['model_config'] as { key: string }).key).toBe('lite');
  });

  it('carries the routing fields the server needs to find a flow', () => {
    // Without these the server answers `flow nodes found for router agent_router`
    // — a 400 that names nothing useful, which is why they are pinned here.
    const encoded = encodeQoderRequest(request, context());
    const decoded = JSON.parse(decodePayload(encoded.body as string)) as Record<string, unknown>;

    expect(decoded['chat_task']).toBe('FREE_INPUT');
    expect(decoded['agent_id']).toBe('agent_common');
    expect(decoded['session_type']).toBe('qodercli');
    expect(decoded['task_id']).toBe('common');
    // Empty on purpose: a value here routes the request away from the free-quota
    // bucket, which is the difference between an answer and a 403.
    expect(decoded['aliyun_user_type']).toBe('');
  });

  it('signs the request into headers rather than into the body', () => {
    const encoded = encodeQoderRequest(request, context());
    const headers = encoded.headers ?? {};

    expect(headers['authorization']).toMatch(/^Bearer COSY\./u);
    expect(headers['cosy-key']).toBeTruthy();
    expect(headers['cosy-date']).toBe('1700000000');
    expect(headers['cosy-user']).toBe('user-1');
    // The signature is over the path without its `/algo` prefix, so the two
    // halves of the same URL disagree by design.
    expect(encoded.path).toContain('/algo/api/v2/service/pro/sse/agent_chat_generation');
  });

  it('asks for a stream even when the client did not', () => {
    // qoder's chat endpoint answers only SSE: the same request with
    // `accept: application/json` comes back `500 Internal Server Error` with no
    // explanation at all, which is what a non-streaming turn used to send. So the
    // codec overrules the transport's choice, and `decodeResponse` is what turns
    // the stream into a whole answer for a client that asked for one.
    const encoded = encodeQoderRequest({ ...request, stream: false }, context());
    expect((encoded.headers ?? {})['accept']).toBe('text/event-stream');
  });

  it('refuses an account that cannot sign, and says which field is missing', () => {
    // A credential stored before the flow recorded the identity. A 401 from the
    // provider would explain nothing; this names the fix.
    expect(() => encodeQoderRequest(request, context({ userId: '' }))).toThrow(/user id/u);
  });
});

describe('the response', () => {
  it('unwraps the envelope and reads the [OI] chunk inside it', () => {
    const body = new TextEncoder().encode(
      envelope({
        id: 'chatcmpl-1',
        model: 'lite',
        created: 1_700_000_000,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' } }],
      }),
    );

    const decoder = createQoderStreamDecoder(context());
    const events = [...decoder.push(body), ...decoder.flush()];

    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.text)).toEqual(['pong']);
  });

  it('reads reasoning out of the same chunk, in its own block', () => {
    // qoder streams `reasoning_content` beside `content`, and the [OI] decoder
    // already knows that field — which is the point of unwrapping rather than
    // re-implementing the chunk.
    const body = new TextEncoder().encode(
      envelope({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] }),
    );

    const decoder = createQoderStreamDecoder(context());
    const events = [...decoder.push(body), ...decoder.flush()];

    expect(events.filter((event) => event.type === 'thinking_delta').map((event) => event.text)).toEqual([
      'thinking',
    ]);
  });

  it('takes the usage from the frame that carries it', () => {
    const body = new TextEncoder().encode(
      envelope({
        choices: [],
        usage: { prompt_tokens: 15, completion_tokens: 68, total_tokens: 83 },
      }),
    );

    const decoder = createQoderStreamDecoder(context());
    const events = [...decoder.push(body), ...decoder.flush()];

    expect(events.find((event) => event.type === 'finish')).toMatchObject({
      usage: { inputTokens: 15, outputTokens: 68, totalTokens: 83 },
    });
  });

  it('reports a refusal as an error, with the reason the account can act on', () => {
    // The shape an account with no credit answers with: a 200 envelope whose
    // inner status is 403, and a message that nests JSON inside JSON.
    const body = new TextEncoder().encode(
      envelope(
        { code: '112', message: JSON.stringify({ pricingUrl: 'https://qoder.com/pricing' }) },
        403,
      ),
    );

    const decoder = createQoderStreamDecoder(context());
    const events = [...decoder.push(body), ...decoder.flush()];

    const error = events.find((event) => event.type === 'error');
    expect(error).toBeDefined();
    expect(error?.type === 'error' ? error.error.message : '').toContain('no credit');
  });

  it('assembles a whole answer out of the same framing', () => {
    const body = new TextEncoder().encode(
      envelope({ choices: [{ index: 0, delta: { content: 'pong' } }] }) +
        envelope({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
    );

    const result = decodeQoderResponse(body, context());

    expect(result.message.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(result.usage.totalTokens).toBe(3);
  });
});

describe('a failed request', () => {
  it('reads the nested message and the status', () => {
    const error = qoderError({
      status: 403,
      body: { code: '112', body: JSON.stringify({ message: JSON.stringify({ pricingUrl: 'https://qoder.com/pricing' }) }) },
      retryAfterSeconds: null,
    });

    expect(error.kind).toBe('permission');
    expect(error.message).toContain('no credit');
  });

  it('falls back to the status when the body carries nothing readable', () => {
    const error = qoderError({ status: 503, body: '', retryAfterSeconds: 3 });
    expect(error.kind).toBe('unavailable');
    expect(error.retryAfterSeconds).toBe(3);
  });
});

describe('the renewal', () => {
  /**
   * A qoder credential is not renewed by re-posting the personal token: what
   * expires is the session token derived from it, and the exchange that derives
   * it is signed with the machine identity recorded at import. That is why this
   * is a codec's job and not a manifest template.
   */

  it('posts to the exchange endpoint on its own host, not the chat host', () => {
    const renewal = renewQoderCredential(context({ machineId: 'machine-1' }));
    expect(renewal.url).toBe('https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1');
  });

  it('signs with the app code, the date, and the machine the account was imported with', () => {
    const renewal = renewQoderCredential(context({ machineId: 'machine-1' }));

    expect(renewal.headers['appcode']).toBe('cosy');
    expect(renewal.headers['cosy-machineid']).toBe('machine-1');
    // RFC 1123, because that is what the signature is computed over — not the
    // unix seconds the chat headers carry.
    expect(renewal.headers['date']).toMatch(/GMT$/u);
    expect(renewal.headers['signature']).toBe(testCrypto.md5Hex('cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&' + renewal.headers['date']));
  });

  it('encodes the body, because the exchange decodes it the same way the chat body is decoded', () => {
    const renewal = renewQoderCredential(context());
    // The custom alphabet has no '+' and no '/', which is what distinguishes an
    // encoded body from a plain JSON one.
    expect(renewal.body).not.toContain('+');
    expect(renewal.body).not.toContain('/');
    expect(renewal.body).not.toContain('{');
  });

  it('reads the answer into the fields this account stores', () => {
    const renewal = renewQoderCredential(context());
    const fields = renewal.read({
      id: 'user-9',
      securityOauthToken: 'session-2',
      refreshToken: 'refresh-2',
      userType: 'personal_pro',
      expireTime: 1_792_312_271_914,
    });

    expect(fields).toEqual({
      securityOauthToken: 'session-2',
      refreshToken: 'refresh-2',
      userId: 'user-9',
      userType: 'personal_pro',
      // Milliseconds upstream, ISO here — the unit does not leak into storage.
      expiresAt: '2026-10-18T08:31:11.914Z',
    });
  });

  it('answers null for an answer that carried no token', () => {
    const renewal = renewQoderCredential(context());
    expect(renewal.read({ message: 'nope' })).toBeNull();
    expect(renewal.read(null)).toBeNull();
  });
});
