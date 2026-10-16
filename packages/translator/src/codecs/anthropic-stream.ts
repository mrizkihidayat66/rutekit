import type { FinishReason } from '@contracts';
import { createUtf8SseDecoder, type SseFrame } from '@shared';

import { asRecord } from '../blocks.ts';
import type { CanonicalStreamEvent } from '../canonical-stream.ts';
import { anthropicError, anthropicFinishReason, decodeAnthropicBlock } from './anthropic.ts';
import { num, str } from './shared.ts';
import type { CodecContext, StreamDecoder } from './types.ts';

/**
 * The Anthropic stream, decoded into the pivot.
 *
 * Almost a copy: the pivot's `block_start`/`*_delta`/`block_stop` triple was
 * taken from this dialect, so each frame maps to one event. The two exceptions
 * are the ones that make the direct route worth having — `signature_delta` has no
 * pivot event, and the `usage` that closes the turn is split across
 * `message_start` (input) and `message_delta` (output), so the finish is held
 * until `message_stop` rather than emitted when the stop reason appears.
 */
export function createAnthropicStreamDecoder(context: CodecContext): StreamDecoder {
  const sse = createUtf8SseDecoder();

  let started = false;
  let finished = false;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let finishReason: FinishReason | null = null;

  const finish = (): CanonicalStreamEvent[] => {
    if (finished) return [];
    finished = true;
    return [
      {
        type: 'finish',
        finishReason: finishReason ?? 'error',
        usage: {
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningTokens: 0,
          totalTokens: inputTokens + outputTokens,
        },
      },
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

    switch (str(record.type) ?? '') {
      case 'message_start': {
        if (started) return [];
        started = true;
        const message = asRecord(record.message) ?? {};
        const usage = asRecord(message.usage) ?? {};
        inputTokens = num(usage.input_tokens) ?? 0;
        cachedInputTokens = num(usage.cache_read_input_tokens) ?? 0;
        return [
          {
            type: 'start',
            id: str(message.id) ?? context.ids.message(),
            model: str(message.model) ?? context.model,
            created: context.now(),
            usage: {
              inputTokens,
              outputTokens: 0,
              cachedInputTokens,
              reasoningTokens: 0,
              totalTokens: inputTokens,
            },
          },
        ];
      }

      case 'content_block_start': {
        const block = decodeAnthropicBlock(record.content_block);
        if (block === null) return [];
        return [{ type: 'block_start', index: num(record.index) ?? 0, block }];
      }

      case 'content_block_delta': {
        const index = num(record.index) ?? 0;
        const delta = asRecord(record.delta) ?? {};
        switch (str(delta.type) ?? '') {
          case 'text_delta':
            return [{ type: 'text_delta', index, text: str(delta.text) ?? '' }];
          case 'thinking_delta':
            return [{ type: 'thinking_delta', index, text: str(delta.thinking) ?? '' }];
          case 'input_json_delta':
            return [
              { type: 'input_json_delta', index, partialJson: str(delta.partial_json) ?? '' },
            ];
          default:
            // `signature_delta` — the pivot has nowhere to keep a signature
            // mid-stream, which is precisely why a Claude client is routed direct.
            return [];
        }
      }

      case 'content_block_stop':
        return [{ type: 'block_stop', index: num(record.index) ?? 0 }];

      case 'message_delta': {
        const delta = asRecord(record.delta) ?? {};
        const reason = str(delta.stop_reason);
        if (reason !== undefined) finishReason = anthropicFinishReason(reason);
        const usage = asRecord(record.usage) ?? {};
        outputTokens = num(usage.output_tokens) ?? outputTokens;
        return finish();
      }

      case 'message_stop':
        return finish();

      case 'ping':
        return [{ type: 'ping' }];

      case 'error':
        finished = true;
        return [
          {
            type: 'error',
            // A mid-stream error carries no HTTP status, so the envelope's own
            // `type` is the only signal; 500 is the fallback for an unknown one.
            error: anthropicError({ status: 500, body: record, retryAfterSeconds: null }),
          },
        ];

      default:
        return [];
    }
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
      events.push(...finish());
      return events;
    },
  };
}
