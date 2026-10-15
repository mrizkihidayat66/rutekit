import type { MappingMatch } from '@contracts';

/**
 * Model mapping (FR-1.5): rewriting the id a client sent, before anything looks
 * it up.
 *
 * This is the earliest decision in the plan and the only one that can change the
 * question rather than the answer. A client that still sends `gpt-4o` after the
 * provider renamed it is fixed here, once, instead of in every combo entry and
 * alias target an operator would otherwise have to keep in step.
 *
 * **First match wins, and only one rule runs.** The rules are an ordered
 * pipeline, not a chain of transforms: a rule whose pattern matches rewrites the
 * id and the walk stops. Chaining would mean a rule's own output could match a
 * later rule, and a pair of rules that happen to be inverses of each other would
 * then depend on where in the list they sit to avoid oscillating. One pass, one
 * rule, one answer is a thing an operator can predict from reading the list.
 *
 * **A rule that cannot run is a rule that does not match.** An unparsable regex
 * is skipped rather than fatal, the same fail-open reading the compression
 * pipeline takes: a typo in one rule must not take down every request that
 * passes through the router. The console's own preview is where a bad pattern is
 * meant to be caught, and it reports the non-match the same way.
 *
 * Pure: rules in, id out, no clock and no database.
 */

/** The part of a rule that decides whether it fires — what a preview needs too. */
export interface MappingPattern {
  readonly match: MappingMatch;
  readonly pattern: string;
  readonly replacement: string;
}

export interface MappingRule extends MappingPattern {
  readonly id: string;
}

export interface MappingOutcome {
  /** The id after the walk, which is the input unchanged when nothing matched. */
  readonly modelId: string;
  /** The rule that fired, or null when none did. */
  readonly ruleId: string | null;
}

/** The rewritten id, or null when this rule does not apply to it. */
export function applyRule(rule: MappingPattern, modelId: string): string | null {
  switch (rule.match) {
    case 'exact':
      return modelId === rule.pattern ? rule.replacement : null;
    case 'contains':
      return modelId.includes(rule.pattern)
        ? modelId.replace(rule.pattern, rule.replacement)
        : null;
    case 'regex':
      return replaceByRegex(rule.pattern, rule.replacement, modelId);
  }
}

/**
 * Rules are expected in priority order — `mappings.listOrdered()` is the only
 * producer — so this walks the array as given rather than sorting again.
 */
export function rewriteModel(
  rules: readonly MappingRule[],
  modelId: string,
): MappingOutcome {
  for (const rule of rules) {
    const next = applyRule(rule, modelId);
    if (next !== null) return { modelId: next, ruleId: rule.id };
  }
  return { modelId, ruleId: null };
}

function replaceByRegex(pattern: string, replacement: string, modelId: string): string | null {
  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch {
    return null;
  }
  return expression.test(modelId) ? modelId.replace(expression, replacement) : null;
}
