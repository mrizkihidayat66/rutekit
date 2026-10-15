import { describe, expect, it } from 'vitest';
import type { ChatAttachment, ContentBlock } from '@contracts';
import type { CanonicalStreamEvent } from '@translator';

import { attachmentBlocks, MAX_TEXT_BYTES } from '@server/chat/attachments.ts';
import { createReplyFold } from '@server/chat/reply.ts';
import { reasoningAsk } from '@server/chat/thinking.ts';
import { demandsOf, unmetBy } from '@server/plan/capability.ts';
import { canonicalRequestSchema } from '@translator';

/**
 * The pure parts of the chat backend (C9).
 *
 * Three small functions, each of which is where a subtle mistake would be
 * invisible in a route test: a fold that loses a block order, a reasoning level
 * that maps onto the wrong key, an attachment that becomes the wrong kind of
 * content. Route tests assert what a turn *did*; these assert what the pieces
 * mean.
 */

/* ---- The reply fold ---- */

function foldOf(events: readonly CanonicalStreamEvent[]): readonly ContentBlock[] {
  const fold = createReplyFold();
  for (const event of events) fold.push(event);
  return fold.content();
}

function text(index: number, value: string): CanonicalStreamEvent[] {
  return [
    { type: 'block_start', index, block: { type: 'text', text: '' } },
    { type: 'text_delta', index, text: value },
    { type: 'block_stop', index },
  ];
}

describe('the reply fold', () => {
  it('keeps the order the model produced, not the order the kinds arrived', () => {
    // The point of the block triple over flat deltas: a turn that thinks, then
    // answers, then calls a tool has an order that a flat delta stream cannot
    // express — and the transcript has to reproduce it.
    const content = foldOf([
      { type: 'block_start', index: 0, block: { type: 'thinking', text: '', signature: null } },
      { type: 'thinking_delta', index: 0, text: 'Hmm.' },
      { type: 'block_stop', index: 0 },
      ...text(1, 'Answer.'),
      { type: 'block_start', index: 2, block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} } },
      { type: 'input_json_delta', index: 2, partialJson: '{"q":1}' },
      { type: 'block_stop', index: 2 },
    ]);

    expect(content.map((block) => block.type)).toEqual(['thinking', 'text', 'tool_use']);
  });

  it('parses a tool call’s arguments, which arrive as fragments', () => {
    const content = foldOf([
      { type: 'block_start', index: 0, block: { type: 'tool_use', id: 'c1', name: 'lookup', input: {} } },
      { type: 'input_json_delta', index: 0, partialJson: '{"q":' },
      { type: 'input_json_delta', index: 0, partialJson: '"x"}' },
      { type: 'block_stop', index: 0 },
    ]);

    expect(content[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } });
  });

  it('keeps a call whose arguments never parsed, with an empty object', () => {
    // The tool ran. Dropping the block would leave a transcript with a hole in
    // it, which is worse than one whose arguments are empty.
    const content = foldOf([
      { type: 'block_start', index: 0, block: { type: 'tool_use', id: 'c1', name: 'lookup', input: {} } },
      { type: 'input_json_delta', index: 0, partialJson: '{"q":' },
      { type: 'block_stop', index: 0 },
    ]);

    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('closes a block the provider never closed', () => {
    // A stream that died mid-sentence left half a sentence on the screen, and
    // that half is what the operator read.
    const content = foldOf([
      { type: 'block_start', index: 0, block: { type: 'text', text: '' } },
      { type: 'text_delta', index: 0, text: 'half a sen' },
      {
        type: 'finish',
        finishReason: 'error',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2,
        },
      },
    ]);

    expect(content).toEqual([{ type: 'text', text: 'half a sen' }]);
  });

  it('reports the finish reason the provider gave', () => {
    const fold = createReplyFold();
    expect(fold.finishReason()).toBeNull();
    fold.push({
      type: 'finish',
      finishReason: 'length',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
      },
    });
    expect(fold.finishReason()).toBe('length');
  });

  it('stores a thinking block without a signature', () => {
    // The signature is the provider's handle for replaying its own reasoning
    // turn. A conversation resumed on the console goes to whatever model the
    // operator picks next, which would not accept the previous one's signature.
    const content = foldOf([
      { type: 'block_start', index: 0, block: { type: 'thinking', text: '', signature: 'sig_x' } },
      { type: 'thinking_delta', index: 0, text: 'Hmm.' },
      { type: 'block_stop', index: 0 },
    ]);

    expect(content[0]).toEqual({ type: 'thinking', text: 'Hmm.', signature: null });
  });

  it('reuses an index for a second block, which some providers do', () => {
    const content = foldOf([...text(0, 'first'), ...text(0, 'second')]);
    expect(content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });
});

/* ---- Thinking levels ---- */

describe('the thinking level', () => {
  it('asks an OpenAI provider for an effort, clamped to the rungs it has', () => {
    expect(reasoningAsk('openai', 'low').extras).toEqual({ reasoning_effort: 'low' });
    // OpenAI has three rungs where the console has five, so the two above `high`
    // clamp: `max` is an operator asking for as much as the model can give.
    expect(reasoningAsk('openai', 'xhigh').extras).toEqual({ reasoning_effort: 'high' });
    expect(reasoningAsk('openai', 'max').extras).toEqual({ reasoning_effort: 'high' });
  });

  it('asks Anthropic for a budget, and raises max_tokens above it', () => {
    const ask = reasoningAsk('anthropic', 'medium');
    expect(ask.extras).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } });
    // Anthropic refuses a budget that is not below `max_tokens`, and the codec's
    // own default of 4096 would be below every budget here.
    expect(ask.maxTokens).toBeGreaterThan(2048);
  });

  it('sends nothing at all for auto', () => {
    // `auto` means "whatever the model does by default". Inventing a level for it
    // would answer a question the operator deliberately left open.
    for (const family of ['openai', 'anthropic', 'google', 'custom'] as const) {
      expect(reasoningAsk(family, 'auto')).toEqual({ extras: {}, maxTokens: null });
    }
  });

  it('sends nothing for the families it cannot spell it for', () => {
    // Google wants `generationConfig.thinkingConfig`, and `extras` are spread at
    // the top level where the codec's own `generationConfig` would overwrite it.
    // A manifest-declared spelling is the fix, not a guess here.
    expect(reasoningAsk('google', 'high').extras).toEqual({});
    expect(reasoningAsk('custom', 'high').extras).toEqual({});
  });

  it('is what makes a model that cannot think see no reasoning at all', () => {
    // The level rides in `extras`, which is where `demandsOf` looks — so the same
    // degradation that drops an image for a blind model drops the effort for a
    // model with no reasoning flag, rather than sending it a parameter it would
    // reject with a 400.
    const request = canonicalRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      extras: reasoningAsk('openai', 'high').extras,
    });

    expect(demandsOf(request)).toContain('thinking');
    expect(unmetBy({ vision: true, tools: true, reasoning: false, embedding: false }, demandsOf(request))).toEqual([
      'thinking',
    ]);
    expect(unmetBy({ vision: true, tools: true, reasoning: true, embedding: false }, demandsOf(request))).toEqual([]);
  });
});

/* ---- Attachments ---- */

function image(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: 'att_1',
    kind: 'image',
    name: 'shot.png',
    mimeType: 'image/png',
    byteSize: 4,
    data: 'AAAA',
    width: 1,
    height: 1,
    ...overrides,
  };
}

function textFile(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: 'att_2',
    kind: 'text',
    name: 'notes.txt',
    mimeType: 'text/plain',
    byteSize: 5,
    data: 'hello',
    width: null,
    height: null,
    ...overrides,
  };
}

describe('attachments', () => {
  it('turns an image into an image block', () => {
    expect(attachmentBlocks([image()])).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'AAAA', url: null },
    ]);
  });

  it('strips a data-URL prefix a caller believed the contract asked for', () => {
    // The contract's comment says "data URL for images" and the console strips
    // the prefix. Accepting both costs one comparison and means the two readings
    // of the field cannot disagree.
    expect(attachmentBlocks([image({ data: 'data:image/png;base64,AAAA' })])).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'AAAA', url: null },
    ]);
  });

  it('names a text file in the block, so the model can refer to it', () => {
    expect(attachmentBlocks([textFile()])).toEqual([
      { type: 'text', text: '[notes.txt]\nhello' },
    ]);
  });

  it('refuses an image over the ceiling, measured from the bytes that arrived', () => {
    // `byteSize` is the client's claim about a file the server never saw, so the
    // length of the base64 that actually arrived is what the limit is checked
    // against.
    const oversized = 'A'.repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3));
    expect(() => attachmentBlocks([image({ byteSize: 4, data: oversized })])).toThrow(/limit is/);
  });

  it('refuses a text file rather than truncating it', () => {
    // A silently shortened log produces a confident answer about the wrong thing.
    const oversized = 'x'.repeat(MAX_TEXT_BYTES + 1);
    expect(() => attachmentBlocks([textFile({ data: oversized, byteSize: oversized.length })])).toThrow(
      /limit is/,
    );
  });

  it('refuses a kind that does not match its media type', () => {
    expect(() => attachmentBlocks([image({ mimeType: 'application/pdf' })])).toThrow(/not an image/);
    expect(() => attachmentBlocks([textFile({ mimeType: 'application/pdf' })])).toThrow(/only images/);
  });
});
