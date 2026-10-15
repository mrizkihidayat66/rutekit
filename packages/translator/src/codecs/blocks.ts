import type { CanonicalStreamEvent } from '../canonical-stream.ts';

/**
 * A canonical block sequence, synthesised from a provider's flat deltas.
 *
 * OpenAI and Google both stream a turn as a bare string of text with no block
 * boundaries, and both report a tool call by position rather than by block. The
 * pivot's vocabulary is the block triple, so a decoder for either family has to
 * invent the boundaries: open a block when the first delta of a kind arrives,
 * close it when another kind starts or the turn ends.
 *
 * This is the one place that knows how to do that, because two of the three
 * families need exactly the same thing. Anthropic does not — it streams the
 * triple itself, which is where the vocabulary came from.
 */
export interface BlockBuilder {
  /** Close every block still open, in index order. Emitted once, at the end. */
  close(): CanonicalStreamEvent[];
  /** A text increment, opening a text block first if none is open. */
  text(delta: string): CanonicalStreamEvent[];
  /** A reasoning increment, opening a thinking block first if none is open. */
  thinking(delta: string): CanonicalStreamEvent[];
  /** Open a tool-call block for `key`. A no-op once that key has been seen. */
  toolStart(key: number, id: string, name: string): CanonicalStreamEvent[];
  /** A fragment of the arguments for the block `key` opened. */
  toolArguments(key: number, partialJson: string): CanonicalStreamEvent[];
}

export function createBlockBuilder(): BlockBuilder {
  let next = 0;
  let open: { index: number; kind: 'text' | 'thinking' } | null = null;
  const toolBlocks: number[] = [];
  const toolIndex = new Map<number, number>();

  const stop = (index: number): CanonicalStreamEvent => ({ type: 'block_stop', index });

  const closeOpen = (): CanonicalStreamEvent[] => {
    if (open === null) return [];
    const index = open.index;
    open = null;
    return [stop(index)];
  };

  const openKind = (kind: 'text' | 'thinking'): { index: number; event: CanonicalStreamEvent } => {
    const index = next;
    next += 1;
    open = { index, kind };
    return {
      index,
      event: {
        type: 'block_start',
        index,
        block:
          kind === 'text'
            ? { type: 'text', text: '' }
            : { type: 'thinking', text: '', signature: null },
      },
    };
  };

  /** The open block of `kind`, opening one if a different kind is in the way. */
  const delta = (kind: 'text' | 'thinking', text: string): CanonicalStreamEvent[] => {
    const events: CanonicalStreamEvent[] = [];
    let index: number;

    if (open !== null && open.kind === kind) {
      index = open.index;
    } else {
      events.push(...closeOpen());
      const started = openKind(kind);
      events.push(started.event);
      index = started.index;
    }

    events.push(
      kind === 'text' ? { type: 'text_delta', index, text } : { type: 'thinking_delta', index, text },
    );
    return events;
  };

  return {
    close() {
      const events = closeOpen();
      // Tool blocks are never "open" — a provider hands over a whole call — so
      // they are closed here rather than when another kind starts.
      for (const index of toolBlocks.splice(0)) events.push(stop(index));
      return events;
    },

    text(delta_) {
      return delta('text', delta_);
    },

    thinking(delta_) {
      return delta('thinking', delta_);
    },

    toolStart(key, id, name) {
      // A provider announces a call once and then streams only its arguments, so
      // a repeat is the same call rather than a second one.
      if (toolIndex.has(key)) return [];

      const events = closeOpen();
      const index = next;
      next += 1;
      toolBlocks.push(index);
      toolIndex.set(key, index);
      events.push({ type: 'block_start', index, block: { type: 'tool_use', id, name, input: {} } });
      return events;
    },

    toolArguments(key, partialJson) {
      const index = toolIndex.get(key);
      if (index === undefined) return [];
      return [{ type: 'input_json_delta', index, partialJson }];
    },
  };
}
