import type { FinishReason, Usage } from '@contracts';
import { createUtf8SseDecoder, type SseFrame } from '@shared';

import { asRecord } from '../blocks.ts';
import type { CanonicalStreamEvent } from '../canonical-stream.ts';
import { createBlockBuilder } from './blocks.ts';
import { googleFinishReason, googleUsage } from './google.ts';
import { arr, str, zeroUsage } from './shared.ts';
import type { CodecContext, StreamDecoder } from './types.ts';

/**
 * The Google stream, decoded into the pivot.
 *
 * The frames are whole `GenerateContentResponse` objects, one per `data:` line,
 * and the stream simply ends when the socket closes — there is no `[DONE]`
 * sentinel. So the finish is emitted from `flush`, by which point the last frame
 * has carried both the finish reason and the token counts.
 *
 * A `functionCall` arrives complete in a single part rather than as argument
 * fragments, so it is written out as one `input_json_delta`.
 */
export function createGoogleStreamDecoder(context: CodecContext): StreamDecoder {
  const sse = createUtf8SseDecoder();
  const builder = createBlockBuilder();

  let started = false;
  let finished = false;
  let finishReason: FinishReason | null = null;
  let usage: Usage | null = null;
  let toolKey = 0;

  const startOf = (record: Record<string, unknown>): CanonicalStreamEvent[] => {
    if (started) return [];
    started = true;
    return [
      {
        type: 'start',
        id: context.ids.chatCompletion(),
        model: str(record.modelVersion) ?? context.model,
        created: context.now(),
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

  const frameOf = (frame: SseFrame): CanonicalStreamEvent[] => {
    if (finished) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      return [];
    }
    const record = asRecord(parsed);
    if (record === null) return [];

    const events = startOf(record);
    const candidate = asRecord(arr(record.candidates)[0]) ?? {};
    const content = asRecord(candidate.content) ?? {};

    for (const part of arr(content.parts)) {
      const partRecord = asRecord(part) ?? {};

      if (typeof partRecord.text === 'string' && partRecord.text !== '') {
        events.push(
          ...(partRecord.thought === true
            ? builder.thinking(partRecord.text)
            : builder.text(partRecord.text)),
        );
        continue;
      }

      const call = asRecord(partRecord.functionCall);
      if (call !== null) {
        const key = toolKey;
        toolKey += 1;
        events.push(
          ...builder.toolStart(key, str(call.id) ?? context.ids.toolCall(), str(call.name) ?? ''),
        );
        events.push(...builder.toolArguments(key, JSON.stringify(asRecord(call.args) ?? {})));
      }
    }

    const reason = str(candidate.finishReason);
    if (reason !== undefined) finishReason = googleFinishReason(reason);
    const meta = asRecord(record.usageMetadata);
    if (meta !== null) usage = googleUsage(meta);

    return events;
  };

  return {
    push(chunk) {
      const events: CanonicalStreamEvent[] = [];
      for (const frame of sse.push(chunk)) events.push(...frameOf(frame));
      return events;
    },

    flush() {
      const events: CanonicalStreamEvent[] = [];
      for (const frame of sse.flush()) events.push(...frameOf(frame));
      events.push(...closeAndFinish());
      return events;
    },
  };
}
