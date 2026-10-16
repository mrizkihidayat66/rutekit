import type { ContentBlock, ErrorKind, Usage } from '@contracts';

/** The narrowing and error helpers all three wire codecs share. */

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A whole response body, decoded and parsed.
 *
 * The three SSE families all answer JSON for a non-streaming request, so this is
 * what their `decodeResponse` starts with. It lives here rather than in the
 * transport because the transport no longer decodes: a body is bytes, and which
 * codec can read them is the codec's own business — kiro's is EventStream and
 * this would destroy it.
 *
 * A body that is not JSON parses to null rather than throwing, which is the same
 * answer the decoders already gave an unreadable body: an empty object, and a
 * result that says nothing was understood.
 */
export function jsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

/**
 * The concatenated text of a block list.
 *
 * Every dialect but Anthropic's carries a turn's text as one flat string, so
 * building a request means flattening the pivot's blocks. A non-text block is
 * skipped here rather than folded in: an image or a tool call has its own
 * spelling in each dialect, and only the codec that owns the dialect knows it.
 */
export function joinText(blocks: readonly ContentBlock[]): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text') text += block.text;
  }
  return text;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function zeroUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

export function usageOf(inputTokens: number, outputTokens: number): Usage {
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

/**
 * A vendor error code that means the account is out of money rather than out of
 * patience. Both arrive as 429 and only the code tells them apart, which matters
 * because the two park an account in different states.
 */
const QUOTA_CODES = ['insufficient_quota', 'quota', 'billing', 'credit'];

/**
 * An HTTP status, read as the pivot's error kind.
 *
 * The status is the fallback rather than the authority: a provider that answers
 * 400 for everything is common enough that the body's own code is checked first
 * where a code exists, and `retryAfterSeconds` is carried alongside rather than
 * turned into a kind, because "retry later" and "you are out of quota" are
 * different answers to the same 429.
 */
export function httpErrorKind(status: number, code: string | null): ErrorKind {
  if (status === 429) {
    const lowered = code?.toLowerCase() ?? '';
    if (QUOTA_CODES.some((marker) => lowered.includes(marker))) return 'quota_exhausted';
    return 'rate_limit';
  }

  switch (status) {
    case 400:
    case 409:
    case 412:
    case 413:
    case 422:
      return 'invalid_request';
    case 401:
      return 'authentication';
    case 402:
      return 'quota_exhausted';
    case 403:
      return 'permission';
    case 404:
      return 'not_found';
    case 408:
    case 504:
      return 'timeout';
    case 500:
      return 'upstream_error';
    case 502:
    case 503:
    case 529: // Anthropic's own "overloaded", a 503 wearing a different number
      return 'unavailable';
    default:
      if (status >= 500) return 'upstream_error';
      if (status >= 400) return 'invalid_request';
      return 'upstream_error';
  }
}

/** The message of last resort, when a body carried nothing readable. */
export function statusMessage(status: number): string {
  return `upstream responded ${status}`;
}
