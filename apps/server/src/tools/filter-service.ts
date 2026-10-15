import type { FilterRule, FilterRuleInput, FilterRuleUpdate, FilterRulesResponse, SearchQuery } from '@contracts';

import { AppError } from '@server/errors.ts';
import type { FilterRuleRow, FilterRulesRepository } from '@server/persistence/filter-rules.ts';

import { asRuleLike, type FilterRuleLike } from './filters.ts';

/**
 * Content filter rules on the console (C8, FR-11.3).
 *
 * The CRUD half; the engine is `filters.ts`. What is worth saying here is the
 * one thing the console cannot express: **position**. A new rule is appended to
 * the end of its phase, and the order rules were created in is the order they
 * run. That is enough for the feature as specified — a `block` rule stops the
 * walk, so the operator wants to know which one is reached first — without
 * building a drag-to-reorder editor the roadmap never asked for.
 */

export interface FilterRuleService {
  list(query: SearchQuery): FilterRulesResponse;
  get(id: string): FilterRule;
  create(input: FilterRuleInput): FilterRule;
  update(id: string, patch: FilterRuleUpdate): FilterRule;
  remove(id: string): void;
  /** The rules the pipeline runs, as the engine reads them. */
  active(): readonly FilterRuleLike[];
}

export interface FilterRuleServiceDeps {
  readonly rules: FilterRulesRepository;
  readonly now?: () => Date;
}

/** A stored row as the console's contract. */
export function toFilterRule(row: FilterRuleRow): FilterRule {
  return {
    id: row.id,
    name: row.name,
    // The columns are written only from the contract's enums, so an unreadable
    // one means the row was edited outside rutekit. `exact` and `block` are the
    // safe readings: a rule reported that way can only match a literal string and
    // can only stop a request the operator plainly meant to stop.
    kind: row.kind === 'regex' ? 'regex' : 'exact',
    pattern: row.pattern,
    action: row.action === 'redact' ? 'redact' : 'block',
    phase: row.phase === 2 ? 2 : 1,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createFilterRuleService(deps: FilterRuleServiceDeps): FilterRuleService {
  const now = deps.now ?? ((): Date => new Date());

  function require(id: string): FilterRuleRow {
    const row = deps.rules.findById(id);
    if (row === null) throw AppError.notFound(`No filter rule with id ${id}.`);
    return row;
  }

  /** The next position within a phase, so a new rule lands at the end of it. */
  function nextPosition(phase: number): number {
    const inPhase = deps.rules.listOrdered().filter((row) => row.phase === phase);
    const last = inPhase.at(-1);
    return last === undefined ? 0 : last.position + 1;
  }

  return {
    list(query: SearchQuery): FilterRulesResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.rules.listOrdered();
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.name, row.pattern].some((value) => value.toLowerCase().includes(needle)),
        );
      }

      const offset = offsetOf(query.cursor);
      const next = offset + query.limit;
      return {
        items: rows.slice(offset, next).map(toFilterRule),
        nextCursor: next < rows.length ? String(next) : null,
        total: rows.length,
      };
    },

    get(id: string): FilterRule {
      return toFilterRule(require(id));
    },

    create(input: FilterRuleInput): FilterRule {
      const at = now().toISOString();
      return toFilterRule(
        deps.rules.create({
          id: crypto.randomUUID(),
          name: input.name,
          kind: input.kind,
          pattern: input.pattern,
          action: input.action,
          phase: input.phase,
          enabled: input.enabled,
          position: nextPosition(input.phase),
          createdAt: at,
          updatedAt: at,
        }),
      );
    },

    update(id: string, patch: FilterRuleUpdate): FilterRule {
      require(id);
      deps.rules.update(
        id,
        {
          name: patch.name,
          kind: patch.kind,
          pattern: patch.pattern,
          action: patch.action,
          phase: patch.phase,
          enabled: patch.enabled,
        },
        now().toISOString(),
      );
      return toFilterRule(require(id));
    },

    remove(id: string): void {
      require(id);
      deps.rules.delete(id);
    },

    active(): readonly FilterRuleLike[] {
      return deps.rules
        .listOrdered()
        .filter((row) => row.enabled)
        .map((row) => asRuleLike(toFilterRule(row)));
    },
  };
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
