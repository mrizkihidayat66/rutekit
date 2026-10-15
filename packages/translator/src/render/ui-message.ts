import type { FinishReason } from '@contracts';
import { sseFrame } from '@shared';

import type { CanonicalStreamEvent } from '../canonical-stream.ts';
import type { StreamRenderer } from './shared.ts';

/**
 * The pivot out to the AI SDK's UI Message stream (C9, FR-7.2).
 *
 * The chat page is built on `useChat`, whose transport reads this protocol and
 * nothing else. So the server has to speak it — and this is the fifth render
 * target beside the four OpenAI/Anthropic surfaces, which is exactly where it
 * belongs: the translator's whole job is turning canonical events into a
 * surface's frames, and "the AI SDK's frames" is one more surface.
 *
 * **Written here rather than by importing `ai`.** ADR-0017 keeps the SDK on the
 * client: the backend stays Hono and does not take a transport library to emit
 * a dozen frame types. AP-10 forbids a hand-written SSE *parser*, which is a
 * different thing — this reads nothing, it writes a documented format whose
 * shape the console's own mock has produced since PHASE B.
 *
 * **The protocol is block-oriented, and so is the pivot.** A canonical stream
 * says `block_start`, some deltas, `block_stop`; the UI Message protocol says
 * `text-start`, some `text-delta`, `text-end`. The mapping is close to the
 * identity, which is the sign that the pivot was the right shape to render from
 * — the one asymmetry is a tool call, whose arguments arrive as JSON fragments
 * and whose final frame carries the parsed input.
 *
 * **Block ids are minted per block, not per index.** The pivot indexes blocks by
 * position; the protocol names them by id, and the two must not be confused — a
 * tool call and a text block can share an index across a provider that reuses
 * them, and an id derived from the index would merge two blocks into one.
 */

/** The frames the AI SDK's UI Message reader understands. */
type UiFrame = Record<string, unknown>;

/** The metadata the chat page renders under an assistant turn (FR-7.9). */
export interface UiMessageMetadata {
  readonly ttftMs: number | null;
  readonly totalMs: number | null;
  readonly tokensPerSecond: number | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly reasoningTokens: number;
    readonly totalTokens: number;
  } | null;
  readonly finishReason: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
}

/** What the renderer is told that the pivot does not carry. */
export interface UiStreamOptions {
  /** The assistant message's id, which the `start` frame announces. */
  readonly messageId: string;
  /** Which provider and model are answering, for the turn's metadata. */
  readonly providerId: string | null;
  readonly model: string | null;
  /** Milliseconds from the request to the first frame. Null until one arrives. */
  readonly ttftMs?: number | null;
  /** Injectable so a test does not read a clock. */
  readonly now?: () => number;
}

/**
 * The contract spells finish reasons with underscores; the wire spells them with
 * hyphens. They are two vocabularies for the same fact and the mapping is not
 * the identity — which is exactly the kind of thing that silently produces an
 * unmapped state three layers down if it is left implicit.
 */
function wireFinishReason(reason: FinishReason): string {
  switch (reason) {
    case 'tool_calls':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    // The rest are spelled the same in both vocabularies, and they are listed
    // rather than defaulted so a new reason in the contract is a type error here
    // instead of an unmapped string on the wire.
    case 'stop':
    case 'length':
    case 'error':
    case 'aborted':
      return reason;
  }
}

export interface UiMessageRenderer extends StreamRenderer {
  /**
   * The frames to write once the provider's stream has ended.
   *
   * Separate from `render` because the protocol's last two frames are the
   * server's, not the provider's: `finish` carries the metadata this process
   * measured, and `[DONE]` is the sentinel the reader stops on.
   */
  finish(): string;
  /** The metadata the `finish` frame carried, for the caller to persist. */
  metadata(): UiMessageMetadata;
}

/**
 * The renderer.
 *
 * Stateful, because the protocol is: `start` announces the message, deltas carry
 * the id of the block they extend, and `finish` closes it. A stateless mapping
 * would have to re-derive which block a delta belongs to on every frame.
 */
export function createUiMessageStream(options: UiStreamOptions): UiMessageRenderer {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  /** Open blocks, by the pivot's index. */
  const open = new Map<number, { id: string; kind: 'text' | 'reasoning' }>();
  /** A tool call's accumulated arguments, by index. */
  const toolJson = new Map<number, { id: string; name: string; partial: string }>();
  /** The pivot's `start` frame teaches the renderer the id it was given. */
  let model = options.model;
  let firstFrameAt: number | null = null;

  let ttftMs = options.ttftMs ?? null;
  let usage: UiMessageMetadata['usage'] = null;
  let finishReason: string | null = null;

  const frame = (chunk: UiFrame): string => sseFrame({ data: JSON.stringify(chunk) });

  /** The first frame's arrival is the turn's time to first token. */
  const touch = (): void => {
    if (firstFrameAt !== null) return;
    firstFrameAt = now();
    ttftMs = firstFrameAt - startedAt;
  };

  /**
   * The turn's numbers as they stand right now.
   *
   * Everything in it is measured, so it changes while the turn is running — which
   * is why the value the `finish` frame carries is frozen rather than recomputed
   * on demand: the console shows what the frame said, and the transcript keeps
   * what `metadata()` says afterwards. Two readings a moment apart would be two
   * different totals for one turn.
   */
  const snapshot = (): UiMessageMetadata => {
    const totalMs = now() - startedAt;
    const streamedMs = Math.max(1, totalMs - (ttftMs ?? 0));
    const outputTokens = usage?.outputTokens ?? 0;

    return {
      ttftMs,
      totalMs,
      // The rate is measured over the streaming window rather than the whole
      // turn, because the time before the first token is latency rather than
      // generation — counting it would report a rate no model produced.
      tokensPerSecond:
        outputTokens === 0 ? null : Math.round((outputTokens / streamedMs) * 1000 * 10) / 10,
      usage,
      finishReason,
      providerId: options.providerId,
      model,
    };
  };

  /** What the `finish` frame carried, once it has been written. */
  let reported: UiMessageMetadata | null = null;

  return {
    render(event: CanonicalStreamEvent): string | null {
      switch (event.type) {
        case 'start': {
          touch();
          model = event.model;
          return frame({
            type: 'start',
            messageId: options.messageId,
            messageMetadata: {
              ttftMs: null,
              totalMs: null,
              tokensPerSecond: null,
              usage: null,
              finishReason: null,
              providerId: options.providerId,
              model: event.model,
            },
          });
        }

        case 'block_start': {
          touch();
          // Only the two prose kinds open a block here. A `tool_use` block opens
          // its own frames when its arguments are known, and a `tool_result` is
          // something the *client* sent rather than something a model produced.
          if (event.block.type === 'text') {
            const id = `txt_${String(event.index)}`;
            open.set(event.index, { id, kind: 'text' });
            return frame({ type: 'text-start', id });
          }
          if (event.block.type === 'thinking') {
            const id = `rsn_${String(event.index)}`;
            open.set(event.index, { id, kind: 'reasoning' });
            return frame({ type: 'reasoning-start', id });
          }
          if (event.block.type === 'tool_use') {
            const id = event.block.id;
            toolJson.set(event.index, { id, name: event.block.name, partial: '' });
            return frame({ type: 'tool-input-start', toolCallId: id, toolName: event.block.name });
          }
          return null;
        }

        case 'text_delta': {
          touch();
          const block = open.get(event.index);
          if (block === undefined || block.kind !== 'text') return null;
          return frame({ type: 'text-delta', id: block.id, delta: event.text });
        }

        case 'thinking_delta': {
          touch();
          const block = open.get(event.index);
          if (block === undefined || block.kind !== 'reasoning') return null;
          return frame({ type: 'reasoning-delta', id: block.id, delta: event.text });
        }

        case 'input_json_delta': {
          touch();
          const call = toolJson.get(event.index);
          if (call === undefined) return null;
          call.partial += event.partialJson;
          // The protocol has a delta frame, and emitting it is what makes a tool
          // call's arguments visible while they arrive rather than in one lump.
          return frame({
            type: 'tool-input-delta',
            toolCallId: call.id,
            inputTextDelta: event.partialJson,
          });
        }

        case 'block_stop': {
          const block = open.get(event.index);
          if (block !== undefined) {
            open.delete(event.index);
            return frame({
              type: block.kind === 'text' ? 'text-end' : 'reasoning-end',
              id: block.id,
            });
          }
          const call = toolJson.get(event.index);
          if (call !== undefined) {
            toolJson.delete(event.index);
            // The parsed input, because the reader wants an object and the frames
            // carried fragments. A call whose arguments never parsed is reported
            // with an empty object rather than dropped: the tool ran, and a UI
            // that lost it would show a turn with a hole in it.
            return frame({
              type: 'tool-input-available',
              toolCallId: call.id,
              toolName: call.name,
              input: parseJson(call.partial),
            });
          }
          return null;
        }

        case 'finish': {
          finishReason = wireFinishReason(event.finishReason);
          usage = {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cachedInputTokens: event.usage.cachedInputTokens,
            reasoningTokens: event.usage.reasoningTokens,
            totalTokens: event.usage.totalTokens,
          };
          // The provider's own finish is not written here: the protocol's
          // `finish` frame carries the metadata this process measured, and it is
          // written by `finish()` once the stream is over. Two frames would leave
          // the reader closing the message twice.
          return null;
        }

        case 'error': {
          // The stream has already been committed, so the failure has to travel
          // in the stream's own dialect rather than as a status code.
          //
          // A turn that died before the provider said how it ended ended with an
          // error, and the `finish` frame below has to say so — reporting `stop`
          // would tell the reader the model finished on its own, which is the one
          // reading that makes a truncated answer look complete. A reason the
          // provider already gave stands: the stream failing afterwards is a
          // transport fault, not a second opinion about the model.
          finishReason ??= 'error';
          return frame({ type: 'error', errorText: event.error.message });
        }

        case 'ping':
          return null;
      }
    },

    finish(): string {
      reported = snapshot();
      return (
        frame({
          type: 'finish',
          finishReason: finishReason ?? 'stop',
          messageMetadata: reported,
        }) + sseFrame({ data: '[DONE]' })
      );
    },

    metadata(): UiMessageMetadata {
      // Before the tail is written there is nothing reported yet, and the caller
      // asking this early is asking what the turn looks like so far.
      return reported ?? snapshot();
    },
  };
}

/** The accumulated argument text, or an empty object when it never parsed. */
function parseJson(partial: string): Record<string, unknown> {
  if (partial.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(partial);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
