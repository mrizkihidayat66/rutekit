import type { CanonicalMessage, ContentBlock } from '@contracts';
import type { CanonicalRequest } from '@translator';

import type { CompressionStage, StageOutcome } from './types.ts';

/**
 * DCP — Duplicate Context Pruning.
 *
 * The cheapest saving in the pipeline, and the only one that is genuinely
 * lossless: it removes content the model has already been given, byte for byte.
 * Two rules, both of them conservative:
 *
 *   - a repeated `assistant` or `tool` turn is dropped when it repeats the turn
 *     immediately before it. A repeated *user* turn is kept — the operator may
 *     have meant the emphasis, and only they know.
 *   - a text part inside a tool result is dropped when an earlier part of the
 *     same result already carried it verbatim.
 *
 * Nothing is summarised and nothing is reordered, so a request DCP has touched
 * is one a careful reader would agree was redundant.
 */

const PRUNABLE_ROLES = new Set(['assistant', 'tool']);

function contentKey(message: CanonicalMessage): string {
  return JSON.stringify(message.content);
}

function sameTurn(a: CanonicalMessage, b: CanonicalMessage): boolean {
  return (
    a.role === b.role &&
    a.name === b.name &&
    a.toolCallId === b.toolCallId &&
    contentKey(a) === contentKey(b)
  );
}

function pruneBlocks<TBlock extends ContentBlock>(blocks: readonly TBlock[]): TBlock[] | null {
  const seen = new Set<string>();
  const kept: TBlock[] = [];
  let dropped = false;

  for (const block of blocks) {
    if (block.type === 'text') {
      if (seen.has(block.text)) {
        dropped = true;
        continue;
      }
      seen.add(block.text);
    }
    kept.push(block);
  }

  return dropped ? kept : null;
}

function pruneToolResult(block: ContentBlock): ContentBlock | null {
  if (block.type !== 'tool_result') return null;
  const content = pruneBlocks(block.content);
  return content === null ? null : { ...block, content };
}

export const dcpStage: CompressionStage = {
  id: 'dcp',
  nature: 'lossless',

  apply(request: CanonicalRequest): StageOutcome | null {
    let changed = false;
    const kept: CanonicalMessage[] = [];

    for (const message of request.messages) {
      const previous = kept[kept.length - 1];
      if (
        previous !== undefined &&
        PRUNABLE_ROLES.has(message.role) &&
        sameTurn(previous, message)
      ) {
        changed = true;
        continue;
      }

      let contentChanged = false;
      const content = message.content.map((block) => {
        const pruned = pruneToolResult(block);
        if (pruned === null) return block;
        contentChanged = true;
        return pruned;
      });

      if (contentChanged) {
        changed = true;
        kept.push({ ...message, content });
      } else {
        kept.push(message);
      }
    }

    return changed ? { request: { ...request, messages: kept } } : null;
  },
};
