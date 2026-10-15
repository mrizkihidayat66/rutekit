import type { AnthropicUsage, ApiError, ContentBlock, FinishReason, ToolUseBlock, Usage } from '@contracts';

import type { CanonicalStreamEvent } from '../canonical-stream.ts';

/** The bits every surface renderer shares. */

export interface StreamRenderer {
  /**
   * One canonical event in, the frames to write out — or null when the event has
   * no counterpart on this surface.
   *
   * A single event can become several frames (Anthropic answers a `finish` with
   * `message_delta` and then `message_stop`), so the return is the concatenation
   * rather than one frame. Returning null rather than '' lets a caller skip the
   * write entirely.
   */
  render(event: CanonicalStreamEvent): string | null;

  /**
   * Frames this surface writes once the provider's stream is over, if any.
   *
   * The pivot's last event is the provider saying it finished; a surface may need
   * to say something after that, and the AI SDK's UI Message protocol does — it
   * closes with a `finish` frame carrying what this process measured, and then the
   * `[DONE]` sentinel its reader stops on. Neither is the provider's to send.
   *
   * Omitted by the four OpenAI-style surfaces, whose dialects have no such tail: for
   * them the provider's own `finish` is already the last word.
   */
  finish?(): string;
}

export function textOf(blocks: readonly ContentBlock[]): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text') text += block.text;
  }
  return text;
}

export function thinkingOf(blocks: readonly ContentBlock[]): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'thinking') text += block.text;
  }
  return text;
}

export function toolUsesOf(blocks: readonly ContentBlock[]): ToolUseBlock[] {
  const calls: ToolUseBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_use') calls.push(block);
  }
  return calls;
}

/**
 * Canonical finish reasons, flattened onto the OpenAI vocabulary.
 *
 * `error` and `aborted` have no OpenAI spelling. They map to null rather than to
 * `stop`, because `stop` says the model finished on its own and a client that
 * believes that will treat a truncated answer as a complete one.
 */
export function openAiFinish(
  reason: FinishReason,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'error':
    case 'aborted':
      return null;
  }
}

/** The same, onto Anthropic's vocabulary. */
export function anthropicStop(
  reason: FinishReason,
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    // Anthropic has no content-filter reason; the turn still ended normally.
    case 'content_filter':
      return 'end_turn';
    case 'error':
    case 'aborted':
      return null;
  }
}

/** The legacy text surface can express neither tool calls nor a refusal. */
export function completionFinish(
  reason: FinishReason,
): 'stop' | 'length' | 'content_filter' | null {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'error':
    case 'aborted':
      return null;
  }
}

export function anthropicUsage(usage: Usage): AnthropicUsage {
  const out: AnthropicUsage = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cachedInputTokens > 0) out.cache_read_input_tokens = usage.cachedInputTokens;
  return out;
}

/** The OpenAI error envelope, shared by three of the four surfaces. */
export function openAiErrorBody(error: ApiError): {
  error: { message: string; type: string; code: string | null; param: string | null };
} {
  return {
    error: { message: error.message, type: error.kind, code: null, param: null },
  };
}

export function anthropicErrorBody(error: ApiError): {
  type: 'error';
  error: { type: string; message: string };
} {
  return { type: 'error', error: { type: error.kind, message: error.message } };
}
