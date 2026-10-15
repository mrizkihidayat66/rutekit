import type { ContentBlock, FinishReason } from '@contracts';
import type { CanonicalStreamEvent } from '@translator';

/**
 * A streamed reply, folded back into the blocks a transcript stores (C9).
 *
 * A stream is deltas and a transcript is blocks, so something has to accumulate
 * one into the other. The pivot has a fold in the other direction — a codec's
 * `decodeResponse` turns a whole body into a `CanonicalResult` — but nothing
 * turns a *stream* into one, because until now nothing needed to: every surface
 * renderer writes its frames as the deltas arrive and keeps no copy.
 *
 * Chat needs the copy. The reply it just streamed to the operator is the reply
 * the transcript has to hold, and the only place it exists in full is here.
 *
 * **The fold follows the block triple, not the deltas.** `block_start` opens a
 * block at an index, deltas extend it, `block_stop` closes it — so a turn that
 * interleaves thinking, text and a tool call comes back in the order the model
 * produced it, which flat deltas could not express. That is the same reason the
 * pivot's stream vocabulary is shaped this way at all.
 *
 * **A tool call's arguments arrive as text and are stored as an object.** The
 * deltas are fragments of JSON that only parse once the block is closed, and a
 * call whose arguments never parsed is stored with an empty object rather than
 * dropped — the tool ran, and a transcript with a hole in it is worse than one
 * with an empty argument list.
 *
 * Pure: events in, blocks out. No clock, no database, no provider.
 */

/** A block being accumulated, keyed by the pivot's own index. */
type OpenBlock =
  | { readonly kind: 'text'; text: string }
  | { readonly kind: 'thinking'; text: string }
  | { readonly kind: 'tool_use'; id: string; name: string; partial: string };

export interface ReplyFold {
  /** One canonical event. Every event is safe to pass, including ones with no content. */
  push(event: CanonicalStreamEvent): void;
  /** The reply so far, in the order the model produced it. */
  content(): readonly ContentBlock[];
  /** How the turn ended, as the provider reported it. Null until it did. */
  finishReason(): FinishReason | null;
}

export function createReplyFold(): ReplyFold {
  // The order of `order` is the order of the transcript; `open` holds what is
  // still being written. An index is reused by some providers after a block
  // closes, which is why a closed block leaves `open` rather than staying in it.
  const order: ContentBlock[] = [];
  const open = new Map<number, OpenBlock>();
  let finish: FinishReason | null = null;

  return {
    push(event: CanonicalStreamEvent): void {
      switch (event.type) {
        case 'block_start':
          open.set(event.index, openBlockOf(event.block));
          break;

        case 'text_delta': {
          const block = open.get(event.index);
          if (block?.kind === 'text') block.text += event.text;
          break;
        }

        case 'thinking_delta': {
          const block = open.get(event.index);
          if (block?.kind === 'thinking') block.text += event.text;
          break;
        }

        case 'input_json_delta': {
          const block = open.get(event.index);
          if (block?.kind === 'tool_use') block.partial += event.partialJson;
          break;
        }

        case 'block_stop': {
          const block = open.get(event.index);
          if (block === undefined) break;
          open.delete(event.index);
          order.push(closeBlock(block));
          break;
        }

        // A block the provider never closed is still content the operator read:
        // a stream that died mid-sentence left half a sentence on the screen, and
        // closing it here is what lets the fold be read at any point.
        case 'finish':
          finish = event.finishReason;
          closeOpen();
          break;

        case 'error':
          closeOpen();
          break;

        case 'start':
        case 'ping':
          break;
      }
    },

    content(): readonly ContentBlock[] {
      return [...order];
    },

    finishReason(): FinishReason | null {
      return finish;
    },
  };

  function closeOpen(): void {
    for (const [index, block] of open) {
      order.push(closeBlock(block));
      open.delete(index);
    }
  }
}

/** The block a `block_start` opened, in the shape this fold accumulates. */
function openBlockOf(block: ContentBlock): OpenBlock {
  switch (block.type) {
    case 'text':
      return { kind: 'text', text: block.text };
    case 'thinking':
      return { kind: 'thinking', text: block.text };
    case 'tool_use':
      return { kind: 'tool_use', id: block.id, name: block.name, partial: '' };
    // An image or a tool result is something a *client* sends, never something a
    // model streams, so a provider that opened one is a fault rather than a
    // block. It is dropped here rather than stored as a lie.
    case 'image':
    case 'tool_result':
      return { kind: 'text', text: '' };
  }
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      // No signature: it is the provider's handle for replaying its own reasoning
      // turn, and a conversation resumed on the console is sent back to whatever
      // model the operator picks next, which would not accept it.
      return { type: 'thinking', text: block.text, signature: null };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: parseJson(block.partial) };
  }
}

function parseJson(partial: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(partial === '' ? '{}' : partial);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
