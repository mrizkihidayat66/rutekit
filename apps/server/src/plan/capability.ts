import type { CanonicalMessage, ContentBlock, TextBlock, ToolResultBlock } from '@contracts';
import type { CanonicalRequest } from '@translator';

/**
 * What a request needs and what a model can do (FR-1.6, C5c).
 *
 * The rule this file exists for is a negative one: **never swap the model behind
 * the client's back.** When the model rutekit is about to call cannot express
 * something the request asked for, there are two honest responses — drop the
 * control, or replace it with a placeholder that says so — and one dishonest one,
 * which is to quietly pick a different model and let the client believe it got
 * what it asked for.
 *
 * So this module answers three questions and nothing else:
 *
 *   1. **What does this request need?** `demandsOf` reads the canonical request
 *      and names the controls it uses: images, tools, a reasoning budget.
 *   2. **Can this model express it?** `unmetBy` compares those against the
 *      model's declared flags and returns the ones it cannot.
 *   3. **What does dropping them look like?** `degrade` rewrites the request.
 *
 * The rewrite is deliberately visible rather than clean. An image becomes a text
 * placeholder naming the model that could not take it; a dropped tool call leaves
 * a marker; a tool *result* keeps its text, because the result is content the
 * conversation already contains and deleting it would change what the model can
 * answer about. The caller reports what was dropped — the dispatcher puts it on a
 * response header — so nothing here is silent.
 *
 * Pure: request in, request out. No clock, no database, no provider.
 */

/**
 * The controls a model can fail to express.
 *
 * `thinking` is the odd one out: it is not a field the pivot carries, it is a set
 * of `extras` keys each surface spells differently (`thinking` on `/v1/messages`,
 * `reasoning` on `/v1/responses`, `reasoning_effort` on `/v1/chat/completions`)
 * plus the thinking blocks a Claude client replays in its history. It maps onto
 * the manifest's `reasoning` flag, which is the closest thing a provider declares.
 */
export type ControlKind = 'vision' | 'tools' | 'thinking';

/** Fixed order, so a header or a log line listing them is stable. */
export const CONTROL_ORDER: readonly ControlKind[] = ['vision', 'tools', 'thinking'];

/** The four flags a manifest model declares. */
export interface ModelFlags {
  readonly vision: boolean;
  readonly tools: boolean;
  readonly reasoning: boolean;
  readonly embedding: boolean;
}

/** Which manifest flag answers for which control. */
const FLAG_OF: Readonly<Record<ControlKind, keyof ModelFlags>> = {
  vision: 'vision',
  tools: 'tools',
  thinking: 'reasoning',
};

/**
 * The `extras` keys that mean "the client asked for reasoning".
 *
 * They are in `extras` rather than in the pivot because the pivot has no column
 * for an extended-thinking budget — see `ingest/messages.ts`, which says as much.
 * Keeping the list here means one place decides what counts as a reasoning
 * request, and the demand and the removal cannot drift apart.
 */
const REASONING_KEYS: ReadonlySet<string> = new Set([
  'thinking',
  'reasoning',
  'reasoning_effort',
]);

/** The controls this request uses, in `CONTROL_ORDER`. */
export function demandsOf(request: CanonicalRequest): ControlKind[] {
  let images = false;
  let tools = request.tools.length > 0 || request.toolChoice !== null;
  let thinking = hasReasoningExtra(request.extras);

  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'image') images = true;
      else if (block.type === 'thinking') thinking = true;
      else if (block.type === 'tool_use' || block.type === 'tool_result') tools = true;
      // An image inside a tool result is still an image the model must accept.
      if (block.type === 'tool_result') {
        if (block.content.some((inner) => inner.type === 'image')) images = true;
      }
    }
  }

  const needed: ControlKind[] = [];
  if (images) needed.push('vision');
  if (tools) needed.push('tools');
  if (thinking) needed.push('thinking');
  return needed;
}

/** The controls this model cannot express, in `CONTROL_ORDER`. Empty when it can express all. */
export function unmetBy(flags: ModelFlags, demands: readonly ControlKind[]): ControlKind[] {
  return CONTROL_ORDER.filter(
    (kind) => demands.includes(kind) && !flags[FLAG_OF[kind]],
  );
}

/**
 * Whether this model can serve a chat turn at all.
 *
 * An embedding model is not a model with a missing capability — it is the wrong
 * kind of model, and no amount of dropping controls makes a chat request into an
 * embedding request. The caller refuses rather than degrades, which is why this
 * is separate from `unmetBy` instead of a fourth `ControlKind`.
 */
export function isChatIncapable(flags: ModelFlags): boolean {
  return flags.embedding;
}

/** The request with `dropped` removed, or a placeholder where removing it would lie. */
export function degrade(
  request: CanonicalRequest,
  dropped: readonly ControlKind[],
  modelId: string,
): CanonicalRequest {
  if (dropped.length === 0) return request;
  const drop = new Set(dropped);

  return {
    ...request,
    messages: request.messages.map((message) => degradeMessage(message, drop, modelId)),
    // A tool definition is a control the client offered, so dropping the control
    // means dropping the offer too — leaving the definitions in place while
    // clearing the history that used them would be two contradictory statements.
    tools: drop.has('tools') ? [] : request.tools,
    toolChoice: drop.has('tools') ? null : request.toolChoice,
    extras: drop.has('thinking') ? withoutReasoning(request.extras) : request.extras,
  };
}

/**
 * One message, degraded.
 *
 * The role is part of the rewrite, not a detail around it. Every codec dispatches
 * on `role === 'tool'` to decide a message is an answer to a call, and renders it
 * from its `tool_result` block — so a tool turn whose block was dropped renders as
 * an empty string carrying a `tool_call_id` for a call that is no longer in the
 * transcript. Both halves have to go together, which is why a degraded tool turn
 * becomes a user turn holding the result as prose.
 */
function degradeMessage(
  message: CanonicalMessage,
  dropped: ReadonlySet<ControlKind>,
  modelId: string,
): CanonicalMessage {
  const content = message.content.flatMap((block) => degradeBlock(block, dropped, modelId));

  if (!dropped.has('tools') || message.role !== 'tool') return { ...message, content };
  return {
    ...message,
    role: 'user',
    content: [toolResultPlaceholder(content)],
    toolCallId: null,
  };
}

/** The text a `tool`-role turn carried, now that it is no longer a tool turn. */
function toolResultPlaceholder(content: readonly ContentBlock[]): TextBlock {
  const text = content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((part) => part !== '')
    .join('\n')
    .trim();
  return { type: 'text', text: text === '' ? '[tool result omitted]' : `[tool result] ${text}` };
}

function degradeBlock(
  block: ContentBlock,
  dropped: ReadonlySet<ControlKind>,
  modelId: string,
): ContentBlock[] {
  switch (block.type) {
    case 'text':
      return [block];

    case 'image':
      return dropped.has('vision') ? [imagePlaceholder(modelId)] : [block];

    case 'thinking':
      // Dropped outright rather than replaced: a thinking block is the model's own
      // reasoning, not conversation content, so a placeholder would put words in
      // the transcript that nobody said.
      return dropped.has('thinking') ? [] : [block];

    case 'tool_use':
      return dropped.has('tools')
        ? [{ type: 'text', text: `[tool call omitted: ${block.name}]` }]
        : [block];

    case 'tool_result': {
      // The pair survives when only vision is missing, so its inner content is
      // degraded in place rather than flattened.
      const content = block.content.map((inner) =>
        inner.type === 'image' && dropped.has('vision') ? imagePlaceholder(modelId) : inner,
      );
      if (!dropped.has('tools')) return [{ ...block, content }];
      return [flattenToolResult(content)];
    }
  }
}

function imagePlaceholder(modelId: string): TextBlock {
  return { type: 'text', text: `[image omitted: ${modelId} cannot accept images]` };
}

/**
 * A tool result as prose.
 *
 * The text is kept and the marker explains why it is there. Deleting it would be
 * tidier on the wire and worse for the answer: the result is usually the whole
 * point of the turn, and a model that cannot see the tool call can still read
 * what it returned.
 */
function flattenToolResult(content: ToolResultBlock['content']): TextBlock {
  const text = content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((part) => part !== '')
    .join('\n')
    .trim();
  return { type: 'text', text: text === '' ? '[tool result omitted]' : `[tool result] ${text}` };
}

function hasReasoningExtra(extras: Readonly<Record<string, unknown>>): boolean {
  for (const key of REASONING_KEYS) {
    if (extras[key] !== undefined) return true;
  }
  return false;
}

function withoutReasoning(
  extras: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extras)) {
    if (!REASONING_KEYS.has(key)) next[key] = value;
  }
  return next;
}
