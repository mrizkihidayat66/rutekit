import type { MappingInput, MappingUpdate, ModelMappingRule } from '@contracts';

import { MATCH_KINDS, rulePatch } from './mapping.ts';

/**
 * The rewrite list as JSON — the bulk-editing path.
 *
 * Editing eight rules one dialog at a time is fine; editing thirty, or moving a
 * set of rules between two installs, is not. So the page can hand the whole list
 * over as text and take it back, which is also the only way to reorder rules
 * quickly when priorities need renumbering.
 *
 * The console API has no bulk endpoint — only per-rule create, update and delete
 * — so applying an edited ruleset means working out the difference and issuing
 * the calls that express it. That difference is computed here, in full, before
 * anything is sent: the operator sees "3 created, 2 updated, 1 deleted" and can
 * back out, rather than discovering it one request at a time.
 *
 * An id that is not in the current list is treated as new rather than as an
 * error. A ruleset pasted from another install is a legitimate thing to want, and
 * the summary shown before Apply is what makes a mistyped id visible — as a
 * create where an update was meant — while it is still free to walk away.
 */

/** One entry of a pasted ruleset: the rule, plus the id it claims to be. */
export interface RulesetEntry {
  readonly id: string | null;
  readonly input: MappingInput;
}

export type RulesetParse =
  | { readonly kind: 'ok'; readonly entries: readonly RulesetEntry[] }
  | { readonly kind: 'error'; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEntry(raw: unknown, index: number): RulesetEntry | string {
  const at = `Rule ${String(index + 1)}`;
  if (!isRecord(raw)) return `${at} is not an object.`;

  const { id, match, pattern, replacement, priority, enabled, description } = raw;

  if (id !== undefined && id !== null && (typeof id !== 'string' || id === '')) {
    return `${at} has an "id" that is not a string.`;
  }
  if (typeof match !== 'string' || !MATCH_KINDS.includes(match as (typeof MATCH_KINDS)[number])) {
    return `${at} has a "match" that is not one of ${MATCH_KINDS.join(', ')}.`;
  }
  if (typeof pattern !== 'string' || pattern === '') {
    return `${at} needs a non-empty "pattern".`;
  }
  if (typeof replacement !== 'string') {
    return `${at} needs a "replacement" string. It may be empty.`;
  }
  if (typeof priority !== 'number' || !Number.isInteger(priority)) {
    return `${at} needs a whole-number "priority".`;
  }
  if (typeof enabled !== 'boolean') {
    return `${at} needs an "enabled" true or false.`;
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return `${at} has a "description" that is neither a string nor null.`;
  }

  return {
    id: typeof id === 'string' ? id : null,
    input: {
      match: match as MappingInput['match'],
      pattern,
      replacement,
      priority,
      description: typeof description === 'string' ? description : null,
      enabled,
    },
  };
}

/**
 * Read a ruleset out of text. Every problem is reported with the rule it is in,
 * because "invalid JSON" on a fifty-rule file is not something anyone can act
 * on. Only the first problem is reported: fixing them one at a time is how the
 * editor already works, and a list of twelve complaints buries the first one.
 */
export function parseRuleset(text: string): RulesetParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : 'That is not valid JSON.',
    };
  }

  if (!Array.isArray(raw)) {
    return { kind: 'error', message: 'A ruleset is a JSON array of rules.' };
  }

  const entries: RulesetEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const entry = readEntry(item, index);
    if (typeof entry === 'string') return { kind: 'error', message: entry };
    if (entry.id !== null) {
      if (seen.has(entry.id)) {
        return {
          kind: 'error',
          message: `Rule ${String(index + 1)} repeats the id "${entry.id}".`,
        };
      }
      seen.add(entry.id);
    }
    entries.push(entry);
  }

  return { kind: 'ok', entries };
}

/** The ruleset as the text the editor opens with. */
export function serialiseRuleset(rules: readonly ModelMappingRule[]): string {
  return JSON.stringify(
    rules.map((rule) => ({
      id: rule.id,
      match: rule.match,
      pattern: rule.pattern,
      replacement: rule.replacement,
      priority: rule.priority,
      enabled: rule.enabled,
      description: rule.description,
    })),
    null,
    2,
  );
}

export interface RulesetPlan {
  readonly creates: readonly MappingInput[];
  readonly updates: readonly { readonly id: string; readonly patch: MappingUpdate }[];
  readonly deletes: readonly string[];
}

export function planRuleset(
  current: readonly ModelMappingRule[],
  next: readonly RulesetEntry[],
): RulesetPlan {
  const byId = new Map(current.map((rule) => [rule.id, rule]));
  const keeps = new Set<string>();
  const creates: MappingInput[] = [];
  const updates: { readonly id: string; readonly patch: MappingUpdate }[] = [];

  for (const entry of next) {
    const existing = entry.id === null ? undefined : byId.get(entry.id);
    if (existing === undefined) {
      creates.push(entry.input);
      continue;
    }
    keeps.add(existing.id);
    const patch = rulePatch(existing, entry.input);
    if (patch !== null) updates.push({ id: existing.id, patch });
  }

  const deletes = current.filter((rule) => !keeps.has(rule.id)).map((rule) => rule.id);
  return { creates, updates, deletes };
}

/** How many requests applying this plan would take. */
export function planSize(plan: RulesetPlan): number {
  return plan.creates.length + plan.updates.length + plan.deletes.length;
}

/** The plan in one line, for the sentence above the Apply button. */
export function planSummary(plan: RulesetPlan): string {
  const parts = [
    [plan.creates.length, 'created'],
    [plan.updates.length, 'updated'],
    [plan.deletes.length, 'deleted'],
  ] as const;
  const said = parts
    .filter(([count]) => count > 0)
    .map(([count, verb]) => `${String(count)} ${verb}`);
  return said.length === 0 ? 'Nothing changed.' : `${said.join(', ')}.`;
}
