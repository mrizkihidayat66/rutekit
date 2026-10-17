import type { ApiError, Usage } from '@contracts';

import { asRecord } from '../blocks.ts';
import type { CanonicalRequest } from '../canonical-request.ts';
import type { CanonicalResult } from '../canonical-result.ts';
import type { CanonicalStreamEvent } from '../canonical-stream.ts';
import { createOpenAiStreamDecoder } from './openai-stream.ts';
import { createUtf8SseDecoder } from '@shared';
import { httpErrorKind, num, statusMessage, str, zeroUsage } from './shared.ts';
import type { CodecContext, EncodedRequest, ErrorInput, StreamDecoder } from './types.ts';

/**
 * qoder's wire: a signed request, answered in [OI] chunks inside an envelope.
 *
 * **The request is nobody else's, and it is signed.** Every header that matters
 * is derived: a session key is generated, encrypted to qoder's public key, and
 * sent as `cosy-key`; an identity blob is AES-encrypted under that key's plaintext
 * and sent inside a base64 payload; and an MD5 over the payload, the key, the
 * date, the encoded body and the path becomes the bearer token. The body itself
 * is JSON run through a custom base64 alphabet and a rotation. None of that is
 * something the pivot could describe, which is why `encodeRequest` returns headers
 * and an already-encoded body rather than an object for the transport to
 * serialise.
 *
 * **The response is [OI] with an envelope around it**, which is the part worth
 * knowing: each SSE frame's `data:` is
 * `{"headers":…,"body":"<a chat.completion.chunk as a string>","statusCode":…}`.
 * So this codec unwraps the envelope and hands the chunk to the [OI] decoder,
 * which already knows what a chunk means — rather than re-implementing delta
 * assembly for a dialect that only differs by one layer of packaging.
 *
 * **Two things about the account are required and are not the token.** The
 * signing payload carries the account's own id and type, so a credential stored
 * without them cannot sign a request at all. The automation flow records both at
 * import time for exactly that reason; a credential that predates it fails with a
 * message naming the missing field rather than with a 401 that explains nothing.
 */

/** The chat endpoint. `AgentId` and `FetchKeys` are part of the signed path. */
const CHAT_URL =
  'https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation' +
  '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

/**
 * qoder's public key, for encrypting a per-session AES key to it.
 *
 * Public by definition — it is the half a client is meant to hold — and the same
 * one every qoder client uses. It is written here rather than fetched because
 * fetching it would add a round trip and a failure mode to every request, and a
 * rotated key breaks every client at once regardless of where the copy lives.
 */
const SERVER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * The alphabet the body is re-encoded into, and its rotation.
 *
 * The standard base64 alphabet maps onto this one, and the encoded string is
 * rotated by a third before substitution. Both are the client's own obfuscation
 * of the request body; neither is encryption, and treating it as such would be
 * the wrong lesson — the signature is what authenticates the call.
 */
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** What the client calls itself. The server routes billing on these. */
const COSY_VERSION = '1.0.22';
const BUSINESS_PRODUCT = 'cli';
const BUSINESS_TYPE = 'agent';
const BUSINESS_VERSION = '1.0.22';
const COSY_SCENE = 'assistant';

/** Routing fields. Without them the server finds no flow node and answers 400. */
const CHAT_TASK = 'FREE_INPUT';
const AGENT_ID = 'agent_common';
const SESSION_TYPE = 'qodercli';
const TASK_ID = 'common';

const BASE64 = (() => {
  const forward = new Map<string, string>();
  for (let index = 0; index < 64; index += 1) {
    forward.set(STANDARD_ALPHABET[index] as string, CUSTOM_ALPHABET[index] as string);
  }
  forward.set('=', '$');
  return forward;
})();

/** Standard base64 of the bytes, then the rotation, then the substitution. */
function encodePayload(text: string): string {
  const standard = base64Of(new TextEncoder().encode(text));
  const length = standard.length;
  const third = Math.floor(length / 3);
  const rotated =
    standard.slice(length - third) + standard.slice(third, length - third) + standard.slice(0, third);

  let out = '';
  for (const character of rotated) {
    const mapped = BASE64.get(character);
    if (mapped === undefined) throw new Error(`qoder: ${character} is not in the payload alphabet`);
    out += mapped;
  }
  return out;
}

/** Base64, written out rather than imported — this package holds no platform APIs. */
function base64Of(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += b === undefined ? '=' : (alphabet[(triple >> 6) & 63] as string);
    out += c === undefined ? '=' : (alphabet[triple & 63] as string);
  }
  return out;
}

/** The signing, and the headers it produces. */
function signedHeaders(
  context: CodecContext,
  bodyEncoded: string,
  identity: string,
  sessionKey: Uint8Array,
): Record<string, string> {
  const sessionKeyEncrypted = context.crypto.rsaEncryptPkcs1(SERVER_PUBLIC_KEY, sessionKey);
  const cosyKey = base64Of(sessionKeyEncrypted);
  const info = base64Of(context.crypto.aesCbcEncrypt(sessionKey, sessionKey, new TextEncoder().encode(identity)));

  const payload = base64Of(
    new TextEncoder().encode(
      JSON.stringify({
        version: 'v1',
        requestId: context.ids.opaque(),
        info,
        cosyVersion: COSY_VERSION,
        ideVersion: '',
      }),
    ),
  );

  const date = String(context.now());
  // The path is signed without its `/algo` prefix, which is what the server
  // strips before it compares.
  const pathSignature = new URL(CHAT_URL).pathname.replace(/^\/algo/u, '');
  const signature = context.crypto.md5Hex(
    `${payload}\n${cosyKey}\n${date}\n${bodyEncoded}\n${pathSignature}`,
  );

  const account = context.account;
  const machineId = account['machineId'] ?? context.ids.opaque();

  return {
    /**
     * This endpoint speaks SSE and nothing else.
     *
     * The transport picks `accept` from whether the client asked for a stream,
     * and a non-streaming turn would therefore ask for `application/json` — to
     * which qoder answers `500 Internal Server Error` with no explanation. It is
     * not a refusal of the account or the body: the same request with
     * `text/event-stream` answers 200 and streams the whole answer.
     *
     * So the codec sets it, and `decodeResponse` is what turns the stream into a
     * whole answer for a client that did not ask for one. `encoded.headers` is
     * merged last precisely so a wire can overrule a default the transport chose
     * on its behalf.
     */
    accept: 'text/event-stream',
    'cosy-data-policy': 'agree',
    'cosy-machinetype': '5',
    'cosy-clienttype': '5',
    'cosy-date': date,
    'cosy-user': account['userId'] ?? '',
    'cosy-key': cosyKey,
    'cache-control': 'no-cache',
    'cosy-business-product': BUSINESS_PRODUCT,
    'cosy-business-type': BUSINESS_TYPE,
    'cosy-scene': COSY_SCENE,
    authorization: `Bearer COSY.${payload}.${signature}`,
    'accept-encoding': 'identity',
    'cosy-version': COSY_VERSION,
    'cosy-machineid': machineId,
    'cosy-machinetoken': machineId,
    'login-version': 'v2',
    'user-agent': 'Go-http-client/2.0',
  };
}

/** The conversation, in this wire's message shape. */
function messagesOf(request: CanonicalRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  const system = request.system.map((block) => block.text).join('\n\n');
  if (system !== '') messages.push({ role: 'system', content: system });

  for (const message of request.messages) {
    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    messages.push({ role: message.role === 'tool' ? 'user' : message.role, content: text });
  }
  return messages;
}

export function encodeQoderRequest(request: CanonicalRequest, context: CodecContext): EncodedRequest {
  const userId = context.account['userId'] ?? '';
  if (userId === '') {
    // Not retryable and not a 401: the credential is missing a field the signing
    // needs, and saying which one is the difference between a fixable message and
    // a mystery.
    throw new Error(
      'this qoder account has no stored user id, which its request signing needs; add the account again so the id is recorded',
    );
  }

  const asked = request.messages.at(-1);
  const prompt = asked === undefined
    ? ''
    : asked.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

  const modelConfig = {
    key: request.model,
    display_name: request.model,
    format: 'openai',
    source: 'system',
    is_vl: false,
    is_reasoning: false,
    max_input_tokens: 200_000,
  };

  const body: Record<string, unknown> = {
    request_id: context.ids.opaque(),
    chat_record_id: context.ids.opaque(),
    request_set_id: context.ids.opaque(),
    session_id: context.ids.opaque(),
    stream: request.stream,
    // Empty on purpose: the client sends nothing here, and a value routes the
    // request away from the free-quota bucket.
    aliyun_user_type: '',
    model_config: modelConfig,
    chat_context: {
      text: { type: 'text', text: prompt },
      extra: { modelConfig, originalContent: { type: 'text', text: prompt } },
      features: [],
      chatPrompt: '',
      imageUrls: null,
    },
    messages: messagesOf(request),
    business: {
      product: BUSINESS_PRODUCT,
      version: BUSINESS_VERSION,
      type: BUSINESS_TYPE,
      id: context.ids.opaque(),
      name: 'rutekit',
      begin_at: context.now() * 1000,
      stage: 'start',
    },
    parameters: {},
    chat_task: CHAT_TASK,
    agent_id: AGENT_ID,
    session_type: SESSION_TYPE,
    task_id: TASK_ID,
    source: 1,
    version: '3',
    is_reply: true,
    is_retry: false,
    code_language: '',
    chat_prompt: '',
  };

  if (request.sampling.maxTokens !== null) {
    (body['parameters'] as Record<string, unknown>)['max_tokens'] = request.sampling.maxTokens;
  }

  // The session key is sixteen bytes of randomness, and it is the AES key the
  // identity is encrypted under — so it comes from the injected id source rather
  // than from a platform call this package does not make.
  const sessionKey = new TextEncoder().encode(context.ids.opaque().slice(0, 16));
  const identity = JSON.stringify({
    name: '',
    aid: userId,
    uid: userId,
    yx_uid: '',
    organization_id: '',
    organization_name: '',
    user_type: context.account['userType'] ?? 'personal_standard',
    security_oauth_token: context.account['securityOauthToken'] ?? '',
    refresh_token: context.account['refreshToken'] ?? '',
  });

  const bodyEncoded = encodePayload(JSON.stringify(body));

  const chatUrl = new URL(CHAT_URL);
  return {
    path: chatUrl.pathname + chatUrl.search,
    // The manifest's base URL is api3; this endpoint is on api2. Naming the origin
    // is the only way to express that, and getting it wrong is a `500` with no
    // explanation rather than a 404.
    origin: chatUrl.origin,
    body: bodyEncoded,
    headers: signedHeaders(context, bodyEncoded, identity, sessionKey),
  };
}

/* ---- the response ---- */

/**
 * The [OI] chunk inside one frame's envelope, as an SSE frame again.
 *
 * Returns null when the frame is not a chunk this codec can read — an error
 * envelope, or a frame whose body is not JSON.
 */
function chunkFrameOf(data: string): { frame: string; error: string | null } | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(data);
  } catch {
    return null;
  }

  const record = asRecord(envelope);
  if (record === null) return null;

  const status = num(record['statusCodeValue']);
  const inner = str(record['body']);
  if (inner === undefined) return null;

  // The envelope carries the failure as a 200 with a status inside it, so the
  // status field is what says whether this frame is an answer or a refusal.
  if (status !== undefined && status >= 400) {
    return { frame: '', error: inner };
  }
  return { frame: `data: ${inner}\n\n`, error: null };
}

/** The message out of a qoder failure body, which nests JSON inside JSON. */
function failureMessage(body: string): string {
  try {
    const outer = asRecord(JSON.parse(body));
    const inner = outer === null ? undefined : str(outer['message']);
    if (inner === undefined) return body.slice(0, 200);
    try {
      const detail = asRecord(JSON.parse(inner));
      const pricing = detail === null ? undefined : str(detail['pricingUrl']);
      // The one refusal worth spelling out: it is not a fault, it is an account
      // with no credit, and the URL is where that is fixed.
      if (pricing !== undefined) return `qoder refused this model: no credit on the account (${pricing})`;
    } catch {
      // The message was not JSON, so it is already the readable form.
    }
    return inner;
  } catch {
    return body.slice(0, 200);
  }
}

export function createQoderStreamDecoder(context: CodecContext): StreamDecoder {
  const outer = createUtf8SseDecoder();
  // The chunks are [OI]'s, so the decoder for that dialect reads them once the
  // envelope is off. Re-implementing delta assembly here would be a second copy
  // of code that already works.
  const inner = createOpenAiStreamDecoder(context);
  const encoder = new TextEncoder();

  let failure: string | null = null;

  const eventsFor = (chunks: Uint8Array): CanonicalStreamEvent[] => {
    const events: CanonicalStreamEvent[] = [];
    for (const frame of outer.push(chunks)) {
      const unwrapped = chunkFrameOf(frame.data);
      if (unwrapped === null) continue;
      if (unwrapped.error !== null) {
        failure = failureMessage(unwrapped.error);
        continue;
      }
      events.push(...inner.push(encoder.encode(unwrapped.frame)));
    }
    return events;
  };

  return {
    push(chunk) {
      return eventsFor(chunk);
    },
    flush() {
      const events: CanonicalStreamEvent[] = [];
      for (const frame of outer.flush()) {
        const unwrapped = chunkFrameOf(frame.data);
        if (unwrapped === null) continue;
        if (unwrapped.error !== null) failure = failureMessage(unwrapped.error);
        else events.push(...inner.push(encoder.encode(unwrapped.frame)));
      }
      events.push(...inner.flush());

      if (failure !== null) {
        return [
          {
            type: 'error',
            error: {
              kind: 'upstream_error',
              message: failure,
              provider: null,
              retryAfterSeconds: null,
              requestId: null,
            },
          },
        ];
      }
      return events;
    },
  };
}

export function decodeQoderResponse(body: Uint8Array, context: CodecContext): CanonicalResult {
  const decoder = createQoderStreamDecoder(context);
  const events = [...decoder.push(body), ...decoder.flush()];

  const failure = events.find((event) => event.type === 'error');
  if (failure !== undefined && failure.type === 'error') throw new Error(failure.error.message);

  let text = '';
  let thinking = '';
  let usage: Usage | null = null;
  for (const event of events) {
    if (event.type === 'text_delta') text += event.text;
    else if (event.type === 'thinking_delta') thinking += event.text;
    else if (event.type === 'finish') usage = event.usage;
  }

  const content: CanonicalResult['message']['content'] = [];
  if (thinking !== '') content.push({ type: 'thinking', text: thinking, signature: null });
  if (text !== '') content.push({ type: 'text', text });

  return {
    id: context.ids.chatCompletion(),
    model: context.model,
    created: context.now(),
    message: { role: 'assistant', content, name: null, toolCallId: null },
    finishReason: 'stop',
    usage: usage ?? zeroUsage(),
  };
}

export function qoderError(input: ErrorInput): ApiError {
  const record = asRecord(input.body);
  const nested = record === null ? undefined : str(record['body']);
  const message =
    nested !== undefined
      ? failureMessage(nested)
      : ((record === null ? undefined : str(record['message'])) ?? statusMessage(input.status));
  const code = record === null ? null : (str(record['code']) ?? null);

  return {
    kind: httpErrorKind(input.status, code),
    message,
    provider: null,
    retryAfterSeconds: input.retryAfterSeconds,
    requestId: null,
  };
}
