import type { ContentBlock, FilterRule, TextBlock } from '@contracts';
import type { CanonicalRequest } from '@translator';

/**
 * Client-supplied content filters, run in two phases (C8, FR-11.3).
 *
 * An operator writes a pattern — a regex or an exact string — and says what
 * happens when a request carries it: block the request, or replace the match
 * before it reaches the provider. That is the whole feature, and it is
 * client-facing rather than a safety net: the rules belong to whoever runs the
 * instance, not to rutekit.
 *
 * **What is scanned is the conversation, not the request.** Message text, the
 * system prompt, and the text inside tool results — the things a person typed or
 * a model wrote. Tool *definitions* are not scanned: `parameters` is JSON Schema,
 * and a regex that matched inside it would produce a schema the provider rejects
 * with a 400, which is a failure a long way from its cause. That is a boundary
 * worth stating rather than discovering.
 *
 * **Phase 1 runs before compression and phase 2 after**, because the two catch
 * different things. A phase-1 rule sees what the client actually sent; a phase-2
 * rule sees what survived the pipeline, which is where a secret reconstructed
 * from a compressed form would show up. The dispatcher owns the placement.
 *
 * **The engine is pure.** Rules in, request in, a verdict out — no clock, no
 * database, no I/O — so the same function serves the pipeline and a test, and
 * there is no second implementation to drift.
 */

/**
 * What a pass over one phase found.
 *
 * A block carries the rule that caused it, and only the subset the caller needs
 * to name it — the pipeline puts the name in the refusal, and carrying the whole
 * stored record would make the engine depend on columns it never reads.
 */
export type FilterOutcome =
  | { readonly kind: 'allowed'; readonly request: CanonicalRequest; readonly redactions: number }
  | { readonly kind: 'blocked'; readonly rule: FilterRuleLike };

export interface FilterRuleLike {
  readonly id: string;
  readonly name: string;
  readonly kind: 'regex' | 'exact';
  readonly pattern: string;
  readonly action: 'block' | 'redact';
  readonly phase: 1 | 2;
  readonly enabled: boolean;
}

/**
 * Whether a rule matches a piece of text.
 *
 * A rule whose regex will not compile matches nothing rather than throwing. The
 * alternative — failing the request — would let a typo in one rule take down
 * every turn, which is the opposite of what a content filter is for. The console
 * is where a bad pattern is meant to be caught, and its own preview reports the
 * non-match the same way.
 */
export function matches(rule: FilterRuleLike, text: string): boolean {
  if (rule.kind === 'exact') return text.includes(rule.pattern);
  const expression = compile(rule.pattern);
  return expression !== null && expression.test(text);
}

/** The text with a rule's matches replaced, or the text unchanged. */
export function redact(rule: FilterRuleLike, text: string): string {
  if (rule.kind === 'exact') return text.split(rule.pattern).join(REDACTION);
  const expression = compile(rule.pattern);
  if (expression === null) return text;
  // A global clone, because a shared regex with the `g` flag carries `lastIndex`
  // between calls and would skip matches on alternate uses.
  return text.replace(new RegExp(expression.source, `${expression.flags}g`), REDACTION);
}

export const REDACTION = '[redacted]';

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Run one phase over a request.
 *
 * Blocking wins over redacting within a phase: a rule that says "block" is a
 * statement about the request, and rewriting the text of a request that is going
 * to be refused anyway would be work with no reader. The rules are walked in the
 * order they were given, which is the order the operator arranged them in, and a
 * `block` rule stops the walk at the first match.
 */
export function applyPhase(
  request: CanonicalRequest,
  rules: readonly FilterRuleLike[],
  phase: 1 | 2,
): FilterOutcome {
  const active = rules.filter((rule) => rule.enabled && rule.phase === phase);
  if (active.length === 0) return { kind: 'allowed', request, redactions: 0 };

  // The block pass runs first and over everything, so a blocked request never
  // pays for the rewriting below it.
  for (const rule of active) {
    if (rule.action !== 'block') continue;
    if (touches(rule, request)) return { kind: 'blocked', rule };
  }

  let redactions = 0;
  const redacting = active.filter((rule) => rule.action === 'redact');
  if (redacting.length === 0) return { kind: 'allowed', request, redactions: 0 };

  const scrub = (text: string): string => {
    let out = text;
    for (const rule of redacting) {
      if (!matches(rule, out)) continue;
      out = redact(rule, out);
      redactions += 1;
    }
    return out;
  };

  const system: TextBlock[] = request.system.map((block) => ({ ...block, text: scrub(block.text) }));
  const messages = request.messages.map((message) => ({
    ...message,
    content: message.content.map((block) => scrubBlock(block, scrub)),
  }));

  return { kind: 'allowed', request: { ...request, system, messages }, redactions };
}

/** Whether a block rule matches anywhere in the conversation. */
function touches(rule: FilterRuleLike, request: CanonicalRequest): boolean {
  for (const block of request.system) {
    if (matches(rule, block.text)) return true;
  }
  for (const message of request.messages) {
    for (const block of message.content) {
      if (blockMatches(rule, block)) return true;
    }
  }
  return false;
}

function blockMatches(rule: FilterRuleLike, block: ContentBlock): boolean {
  if (block.type === 'text') return matches(rule, block.text);
  // A tool result is content the model will read, so its text is scanned; the
  // call's own arguments are not, for the same reason tool definitions are not —
  // they are structure rather than prose.
  if (block.type === 'tool_result') {
    // A tool result's content is text and images; only the text is scanned.
    return block.content.some((inner) => inner.type === 'text' && matches(rule, inner.text));
  }
  return false;
}

function scrubBlock(block: ContentBlock, scrub: (text: string) => string): ContentBlock {
  if (block.type === 'text') return { ...block, text: scrub(block.text) };
  if (block.type === 'tool_result') {
    return {
      ...block,
      content: block.content.map((inner) =>
        inner.type === 'text' ? { ...inner, text: scrub(inner.text) } : inner,
      ),
    };
  }
  return block;
}

/**
 * A stored rule as the engine reads it.
 *
 * The engine takes the subset it uses rather than the whole contract type, so a
 * test can describe a rule without inventing timestamps — and so the engine
 * cannot quietly start depending on a field the pipeline does not have.
 */
export function asRuleLike(rule: FilterRule): FilterRuleLike {
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    pattern: rule.pattern,
    action: rule.action,
    phase: rule.phase,
    enabled: rule.enabled,
  };
}
