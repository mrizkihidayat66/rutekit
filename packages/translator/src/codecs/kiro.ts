import type {
  ApiError,
  CanonicalMessage,
  ContentBlock,
  FinishReason,
  ToolUseBlock,
  Usage,
} from '@contracts';

import { asRecord, parseToolArguments } from '../blocks.ts';
import type { CanonicalRequest } from '../canonical-request.ts';
import type { CanonicalResult } from '../canonical-result.ts';
import type { CanonicalStreamEvent } from '../canonical-stream.ts';
import { createBlockBuilder } from './blocks.ts';
import { EventStreamDecoder, type EventStreamFrame } from './kiro-eventstream.ts';
import { httpErrorKind, joinText, num, statusMessage, str, zeroUsage } from './shared.ts';
import type { CodecContext, EncodedRequest, ErrorInput, StreamDecoder } from './types.ts';

/**
 * kiro's wire — a JSON request of its own shape, answered in AWS EventStream.
 *
 * **Why this is a family and not a variant of one of the three SSE dialects.**
 * The request is nobody else's: a `conversationState` object carrying a current
 * message and a history, with the account's own `profileArn` alongside. The
 * response is not SSE at all — it is length-prefixed binary, which is what
 * `kiro-eventstream.ts` exists for. So this file is the fourth codec, and the
 * seam it needed (bytes rather than text, and the account's fields in the
 * context) was worth changing for it rather than special-casing.
 *
 * **The account's `profileArn` is not optional.** kiro issues one beside the
 * token and its runtime refuses a request without it — `profileArn is required
 * for this request` — in the body *and* as a query parameter. That is why the
 * codec reads `context.account`: it is a value out of the credential, the pivot
 * has no field for it, and no other layer knows where this wire wants it.
 *
 * **The model id is sent as the client asked for it.** The catalogue's kiro
 * entries are curated names, and the runtime accepted every one that was tried
 * (`auto`, `glm-5`, `deepseek-3.2`, …) once a profile was present. An empty id is
 * the one value it rejects, which is what the manifest's placeholder entries used
 * to send.
 */

const CHAT_PATH = '/generateAssistantResponse';

/** kiro's own name for what this call is. It is a required field, not a hint. */
const ORIGIN = 'AI_EDITOR';
const TASK_TYPE = 'vibe';
const TRIGGER_TYPE = 'MANUAL';

/** A tool call's arguments arrive as a JSON string, usually in pieces. */
function toolInputOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return '';
}

/**
 * One message of the conversation, in this wire's spelling.
 *
 * The two roles are not symmetric: a user turn is a `userInputMessage` and an
 * assistant turn is an `assistantResponseMessage`, which is why this returns a
 * union the caller spreads rather than one object with a `role` field.
 */
function historyEntryOf(message: CanonicalMessage, modelId: string): Record<string, unknown> | null {
  const text = joinText(message.content);

  if (message.role === 'assistant') {
    const toolUses = message.content
      .filter((block): block is ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        toolUseId: block.id,
        name: block.name,
        input: block.input,
      }));
    return {
      assistantResponseMessage: {
        content: text,
        ...(toolUses.length > 0 ? { toolUses } : {}),
      },
    };
  }

  if (message.role === 'tool' || message.role === 'user') {
    const results = message.content.filter((block) => block.type === 'tool_result');
    return {
      userInputMessage: {
        content: text,
        modelId,
        origin: ORIGIN,
        userInputMessageContext:
          results.length > 0
            ? {
                toolResults: results.map((block) => ({
                  toolUseId: 'toolUseId' in block ? block.toolUseId : '',
                  content: joinText('content' in block ? block.content : []),
                })),
              }
            : {},
      },
    };
  }

  // A system turn is hoisted into the current message by the caller, so one that
  // reaches here has nothing this wire can carry.
  return null;
}

/**
 * The request body, and the path that carries the account's profile.
 *
 * The profile travels twice on purpose: the runtime reads the query parameter for
 * routing and the body field for authorisation, and sending only one is refused.
 * That is the provider's own arrangement, not a belt-and-braces choice here.
 */
export function encodeKiroRequest(
  request: CanonicalRequest,
  context: CodecContext,
): EncodedRequest {
  const profileArn = context.account['profileArn'] ?? '';
  const modelId = request.model;

  // The last turn is the one being asked; everything before it is context.
  const messages = request.messages;
  const last = messages.at(-1);
  const history = messages
    .slice(0, Math.max(0, messages.length - 1))
    .map((message) => historyEntryOf(message, modelId))
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  // kiro has no system field, so a system prompt is prepended to the turn's text —
  // which is what its own client does.
  const system = request.system.map((block) => block.text).join('\n\n');
  const asked = last === undefined ? '' : joinText(last.content);
  const content = [system, asked].filter((part) => part !== '').join('\n\n');

  const body: Record<string, unknown> = {
    conversationState: {
      agentContinuationId: context.ids.opaque(),
      agentTaskType: TASK_TYPE,
      chatTriggerType: TRIGGER_TYPE,
      conversationId: context.ids.opaque(),
      currentMessage: {
        userInputMessage: {
          content,
          modelId,
          origin: ORIGIN,
          userInputMessageContext: {},
        },
      },
      history,
    },
  };
  if (profileArn !== '') body['profileArn'] = profileArn;

  const path =
    profileArn === ''
      ? CHAT_PATH
      : `${CHAT_PATH}?profileArn=${encodeURIComponent(profileArn)}`;

  return { path, body };
}

/* ---- the response ---- */

/**
 * The payload of a frame, unwrapped.
 *
 * kiro nests the interesting object under a key named for the event, and which
 * key it is varies by event type, so the frame's own header is the authority and
 * the fallback list is for a header that did not arrive.
 */
function payloadOf(frame: EventStreamFrame): Record<string, unknown> | null {
  const direct = asRecord(frame.payload);
  if (direct === null) return null;
  if (frame.eventType !== null) {
    const nested = asRecord(direct[frame.eventType]);
    if (nested !== null) return nested;
  }
  for (const key of [
    'assistantResponseEvent',
    'toolUseEvent',
    'meteringEvent',
    'contextUsageEvent',
    'messageMetadataEvent',
  ]) {
    const nested = asRecord(direct[key]);
    if (nested !== null) return nested;
  }
  return direct;
}

/** The text a frame carries, or '' when it is not a text frame. */
function textOf(frame: EventStreamFrame): string {
  const type = frame.eventType ?? '';
  if (/reason|thinking/i.test(type)) return '';
  if (!/assistant|response|text|content/i.test(type)) return '';

  const payload = payloadOf(frame);
  if (payload === null) return '';
  for (const key of ['content', 'text', 'delta']) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** The reasoning a frame carries, for a wire that streams it separately. */
function thinkingOf(frame: EventStreamFrame): string {
  const type = frame.eventType ?? '';
  if (!/reason|thinking/i.test(type)) return '';
  const payload = payloadOf(frame);
  if (payload === null) return '';
  for (const key of ['text', 'content', 'delta']) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** The usage a frame reports, or null when it reports none. */
function usageOf(frames: readonly EventStreamFrame[]): Usage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let seen = false;

  for (const frame of frames) {
    const payload = payloadOf(frame);
    if (payload === null) continue;
    const usage = asRecord(payload['usage']) ?? payload;

    const input = num(usage['inputTokens']) ?? num(usage['input_tokens']);
    const output = num(usage['outputTokens']) ?? num(usage['output_tokens']);
    if (input === undefined && output === undefined) continue;

    seen = true;
    inputTokens = Math.max(inputTokens, input ?? 0);
    outputTokens = Math.max(outputTokens, output ?? 0);
  }

  if (!seen) return null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

/** The tool calls the frames assembled, keyed so a streamed call is one call. */
function toolCallsOf(frames: readonly EventStreamFrame[]): ToolUseBlock[] {
  const byId = new Map<string, { id: string; name: string; input: string }>();

  for (const frame of frames) {
    if (!/tooluse/i.test(frame.eventType ?? '')) continue;
    const payload = payloadOf(frame);
    if (payload === null) continue;

    const id = str(payload['toolUseId']) ?? str(payload['id']);
    if (id === undefined) continue;
    const name = str(payload['name']) ?? '';

    const existing = byId.get(id) ?? { id, name: '', input: '' };
    if (name !== '') existing.name = name;
    existing.input += toolInputOf(payload['input']);
    byId.set(id, existing);
  }

  const calls: ToolUseBlock[] = [];
  for (const call of byId.values()) {
    // A call whose name never arrived is one this codec cannot describe, and
    // reporting it with an empty name would send the client a tool it cannot
    // dispatch. It is dropped rather than guessed at.
    if (call.name === '') continue;
    calls.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: parseToolArguments(call.input),
    });
  }
  return calls;
}

/** A frame that says the stream failed, as an error rather than as content. */
function failureOf(frame: EventStreamFrame): string | null {
  if (frame.messageType !== 'error' && frame.messageType !== 'exception') return null;
  const payload = asRecord(frame.payload);
  const message = payload === null ? null : str(payload['message']);
  return message ?? frame.payloadText.slice(0, 300);
}

export function decodeKiroResponse(body: Uint8Array, context: CodecContext): CanonicalResult {
  const frames = new EventStreamDecoder().push(body);

  const failure = frames.map(failureOf).find((message) => message !== null);
  if (failure !== undefined && failure !== null) {
    throw new Error(`kiro refused the turn: ${failure}`);
  }

  const text = frames.map(textOf).join('');
  const thinking = frames.map(thinkingOf).join('');
  const calls = toolCallsOf(frames);

  const blocks: ContentBlock[] = [];
  if (thinking !== '') blocks.push({ type: 'thinking', text: thinking, signature: null });
  if (text !== '') blocks.push({ type: 'text', text });
  blocks.push(...calls);

  const finishReason: FinishReason = calls.length > 0 ? 'tool_calls' : 'stop';

  return {
    id: context.ids.chatCompletion(),
    model: context.model,
    created: context.now(),
    message: { role: 'assistant', content: blocks, name: null, toolCallId: null },
    finishReason,
    usage: usageOf(frames) ?? zeroUsage(),
  };
}

/**
 * The stream, decoded frame by frame.
 *
 * kiro answers a stream for every request, so this is the path a turn normally
 * takes and `decodeKiroResponse` is the fallback for a caller that asked for a
 * whole answer — the bytes are the same, and both go through the same framing.
 */
export function createKiroStreamDecoder(context: CodecContext): StreamDecoder {
  const stream = new EventStreamDecoder();
  const builder = createBlockBuilder();

  let started = false;
  let finished = false;
  let usage: Usage | null = null;
  let sawToolUse = false;
  const all: EventStreamFrame[] = [];

  const startOf = (): CanonicalStreamEvent[] => {
    if (started) return [];
    started = true;
    return [
      {
        type: 'start',
        id: context.ids.chatCompletion(),
        model: context.model,
        created: context.now(),
        usage: null,
      },
    ];
  };

  const eventsFor = (frames: readonly EventStreamFrame[]): CanonicalStreamEvent[] => {
    const events: CanonicalStreamEvent[] = [];
    for (const frame of frames) {
      all.push(frame);

      const failure = failureOf(frame);
      if (failure !== null) {
        events.push({
          type: 'error',
          error: {
            kind: 'upstream_error',
            message: `kiro refused the turn: ${failure}`,
            provider: null,
            retryAfterSeconds: null,
            requestId: null,
          },
        });
        continue;
      }

      events.push(...startOf());

      const text = textOf(frame);
      if (text !== '') events.push(...builder.text(text));

      const thinking = thinkingOf(frame);
      if (thinking !== '') events.push(...builder.thinking(thinking));
    }
    return events;
  };

  const closeAndFinish = (): CanonicalStreamEvent[] => {
    if (finished) return [];
    finished = true;

    // The tool calls are assembled from the whole stream rather than per frame,
    // because one call arrives as several frames that only make sense together —
    // the name in the first and the arguments spread across the rest.
    const calls = toolCallsOf(all);
    const events: CanonicalStreamEvent[] = [];
    for (const [index, call] of calls.entries()) {
      sawToolUse = true;
      events.push(...builder.toolStart(index, call.id, call.name));
      events.push(...builder.toolArguments(index, JSON.stringify(call.input)));
    }

    const reported = usageOf(all);
    if (reported !== null) usage = reported;

    return [
      ...events,
      ...builder.close(),
      {
        type: 'finish',
        finishReason: sawToolUse ? 'tool_calls' : 'stop',
        usage: usage ?? zeroUsage(),
      },
    ];
  };

  return {
    push(chunk) {
      if (finished) return [];
      return eventsFor(stream.push(chunk));
    },
    flush() {
      if (finished) return [];
      // A frame the stream never completed is not invented here: a truncated
      // response is a truncated response, and the transport's stall clock is
      // what reports it. What is left is closing what did arrive.
      return closeAndFinish();
    },
  };
}

/**
 * A failed request, read as the pivot's error kind.
 *
 * kiro answers a failure in JSON — the 403 that reported a suspended account was
 * `{"message": …, "reason": "TEMPORARILY_SUSPENDED"}` — so the reason field is
 * what carries the vendor's own code, and the status is the fallback.
 */
export function kiroError(input: ErrorInput): ApiError {
  const record = asRecord(input.body);
  const message =
    (record === null ? undefined : str(record['message'])) ??
    (record === null ? undefined : str(record['reason'])) ??
    statusMessage(input.status);
  const code = record === null ? null : (str(record['reason']) ?? null);

  return {
    kind: httpErrorKind(input.status, code),
    message,
    provider: null,
    retryAfterSeconds: input.retryAfterSeconds,
    requestId: null,
  };
}
