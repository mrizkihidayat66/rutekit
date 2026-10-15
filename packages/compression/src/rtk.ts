import type { ToolResultBlock } from '@contracts';
import type { CanonicalRequest } from '@translator';

import { RTK_FILTERS, type RtkFilter } from './rtk-filters.ts';
import type { CompressionStage, StageContext, StageOutcome } from './types.ts';

/**
 * RTK — the tool-result filters.
 *
 * Tool output is where a context window actually goes: a directory listing, a
 * diff and a build log are all far larger than the answer they carry. Each of
 * the twelve filters recognises one shape and rewrites it, and only the filters
 * the operator turned on are tried.
 *
 * This is the pipeline's *lossy* stage, so the operator's filter set is the
 * whole contract: a filter that is off is never applied, and a result no enabled
 * filter recognises is passed through untouched rather than truncated by
 * something that guessed.
 */

function pruneText(text: string, filters: readonly RtkFilter[]): string {
  for (const filter of filters) {
    if (filter.detect(text)) return filter.apply(text);
  }
  return text;
}

function pruneResult(block: ToolResultBlock, filters: readonly RtkFilter[]): ToolResultBlock | null {
  let changed = false;
  const content = block.content.map((part) => {
    if (part.type !== 'text') return part;
    const text = pruneText(part.text, filters);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...block, content } : null;
}

export const rtkStage: CompressionStage = {
  id: 'rtk',
  nature: 'lossy',

  apply(request: CanonicalRequest, context: StageContext): StageOutcome | null {
    const filters = RTK_FILTERS.filter((filter) => context.rtkFilters[filter.id] === true);
    if (filters.length === 0) return null;

    let changed = false;
    const messages = request.messages.map((message) => {
      let messageChanged = false;
      const content = message.content.map((block) => {
        if (block.type !== 'tool_result') return block;
        const pruned = pruneResult(block, filters);
        if (pruned === null) return block;
        messageChanged = true;
        return pruned;
      });

      if (!messageChanged) return message;
      changed = true;
      return { ...message, content };
    });

    return changed ? { request: { ...request, messages } } : null;
  },
};
