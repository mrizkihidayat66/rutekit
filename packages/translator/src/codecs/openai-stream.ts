import type { FinishReason, Usage } from '@contracts';
import { createSseDecoder, type SseFrame } from '@shared';

import { asRecord } from '../blocks.ts';
import type { CanonicalStreamEvent } from '../canonical-stream.ts';
import { createBlockBuilder } from './blocks.ts';
import { openAiFinishReason, openAiUsage } from './openai.ts';
import { arr, num, str, zeroUsage } from './shared.ts';
import type { CodecContext, StreamDecoder } from './types.ts';

/**
 * The OpenAI stream, decoded into the pivot.
 *
 * Every frame is a whole JSON chunk under `data:`, and the stream ends with a
 * literal `data: [DONE]`. The chunk that carries `finish_reason` and the chunk
 * that carries `usage` are usually two different frames — the second only arrives
 * because `encodeRequest` asked for it — so the finish is held until the stream
 * ends rather than emitted when the reason appears.
 */
export function createOpenAiStreamDecoder(context: CodecContext): StreamDecoder {
  const sse = createSseDecoder();
  const builder = createBlockBuilder();

  let started = false;
  let finished = false;
  let finishReason: FinishReason | null = null;
  let usage: Usage | null = null;

  /** The opening event, which teaches the renderer the id and model it needs. */
  const startOf = (chunk: Record<string, unknown>): CanonicalStreamEvent[] => {
    if (started) return [];
    started = true;
    return [
      {
        type: 'start',
        id: str(chunk.id) ?? context.ids.chatCompletion(),
        model: str(chunk.model) ?? context.model,
        created: num(chunk.created) ?? context.now(),
        usage: null,
      },
    ];
  };

  const closeAndFinish = (): CanonicalStreamEvent[] => {
    if (finished) return [];
    finished = true;
    return [
      ...builder.close(),
      { type: 'finish', finishReason: finishReason ?? 'error', usage: usage ?? zeroUsage() },
    ];
  };

  const chunkOf = (frame: SseFrame): CanonicalStreamEvent[] => {
    if (finished) return [];
    if (frame.data === '[DONE]') return closeAndFinish();

    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      // A frame that is not JSON is a keepalive or a vendor extension; the
      // shared decoder already dropped the comment form, so this is just noise.
      return [];
    }
    const chunk = asRecord(parsed);
    if (chunk === null) return [];

    const events = startOf(chunk);

    const choice = asRecord(arr(chunk.choices)[0]);
    if (choice !== null) {
      const delta = asRecord(choice.delta) ?? {};

      const content = str(delta.content);
      if (content !== undefined && content !== '') events.push(...builder.text(content));

      const reasoning = str(delta.reasoning_content);
      if (reasoning !== undefined && reasoning !== '') events.push(...builder.thinking(reasoning));

      for (const call of arr(delta.tool_calls)) {
        const callRecord = asRecord(call) ?? {};
        const key = num(callRecord.index) ?? 0;
        const fn = asRecord(callRecord.function) ?? {};
        const name = str(fn.name);
        // The name arrives once, on the chunk that opens the call; the chunks
        // after it carry only argument fragments. `toolStart` is idempotent per
        // key, so a provider that repeats the name does not open a second block.
        if (name !== undefined) {
          events.push(...builder.toolStart(key, str(callRecord.id) ?? context.ids.toolCall(), name));
        }
        const args = str(fn.arguments);
        if (args !== undefined && args !== '') events.push(...builder.toolArguments(key, args));
      }

      const reason = str(choice.finish_reason);
      if (reason !== undefined) finishReason = openAiFinishReason(reason);
    }

    const chunkUsage = asRecord(chunk.usage);
    if (chunkUsage !== null) usage = openAiUsage(chunkUsage);

    return events;
  };

  return {
    push(chunk) {
      const events: CanonicalStreamEvent[] = [];
      for (const frame of sse.push(chunk)) events.push(...chunkOf(frame));
      return events;
    },

    flush() {
      const events: CanonicalStreamEvent[] = [];
      for (const frame of sse.flush()) events.push(...chunkOf(frame));
      events.push(...closeAndFinish());
      return events;
    },
  };
}
