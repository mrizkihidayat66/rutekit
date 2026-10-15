import type { TextBlock } from '@contracts';

/** The bits every ingest shares. */

/**
 * Everything the pivot does not model, kept verbatim.
 *
 * Each surface schema ends in `.catchall(z.unknown())` precisely so this can be
 * done: a client that sends `logit_bias`, or a provider parameter rutekit has
 * not learned yet, gets it carried through instead of having it silently
 * dropped on the way in.
 */
export function extrasOf(
  body: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!known.has(key)) extras[key] = value;
  }
  return extras;
}

/** `stop` arrives as one string or a list, and the pivot keeps only the list. */
export function stopList(stop: string | readonly string[] | undefined): string[] {
  if (stop === undefined) return [];
  return typeof stop === 'string' ? [stop] : [...stop];
}

export function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}

export function userMessage(text: string): {
  role: 'user';
  content: TextBlock[];
  name: null;
  toolCallId: null;
} {
  return { role: 'user', content: [textBlock(text)], name: null, toolCallId: null };
}
