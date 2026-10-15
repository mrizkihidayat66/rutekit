import type {
  MappingInput,
  MappingMatch,
  MappingPreviewBody,
  MappingPreviewResult,
  MappingUpdate,
  MappingsResponse,
  ModelMappingRule,
  SearchQuery,
} from '@contracts';
import { mappingMatchSchema } from '@contracts';

import { AppError } from '@server/errors.ts';
import type { MappingRow, MappingsRepository } from '@server/persistence/mappings.ts';

import { applyRule } from '@server/plan/mapping.ts';

import { offsetOf, paginate, sortRows } from './list.ts';

/**
 * Model mapping (FR-1.5).
 *
 * The preview is the reason this file imports the engine rather than reimplementing
 * it. A preview that computed the match with its own copy of the rules would be a
 * second source of truth, and the one thing a preview must never do is agree with
 * a panel and disagree with a turn. So `applyRule` — the same function the planner
 * walks — answers here too, and a bad pattern that the planner skips is reported
 * as a non-match rather than as an error the preview alone would show.
 */

/** The match mode to report for a column holding something unrecognisable. */
const UNKNOWN_MATCH: MappingMatch = 'exact';

export interface MappingService {
  list(query: SearchQuery): MappingsResponse;
  get(id: string): ModelMappingRule;
  create(input: MappingInput): ModelMappingRule;
  update(id: string, patch: MappingUpdate): ModelMappingRule;
  remove(id: string): void;
  /** Run a draft rule against sample ids. Writes nothing. */
  preview(body: MappingPreviewBody): MappingPreviewResult;
}

export interface MappingServiceDeps {
  readonly mappings: MappingsRepository;
  readonly now?: () => Date;
}

/**
 * The stored row as the console's contract.
 *
 * `match` falls back to `exact` rather than throwing, the same reading
 * `toAccount` takes for an unreadable state: the column is written only from the
 * contract's enum, so an unreadable one means the row was edited outside rutekit
 * — and `exact` is the safe reading, because a rule reported that way can only
 * fire on an id identical to its pattern.
 */
export function toMapping(row: MappingRow): ModelMappingRule {
  const parsed = mappingMatchSchema.safeParse(row.match);
  return {
    id: row.id,
    match: parsed.success ? parsed.data : UNKNOWN_MATCH,
    pattern: row.pattern,
    replacement: row.replacement,
    priority: row.priority,
    enabled: row.enabled,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SORTERS: Record<string, (row: MappingRow) => string | number> = {
  priority: (row) => row.priority,
  pattern: (row) => row.pattern.toLowerCase(),
  createdAt: (row) => row.createdAt,
};

export function createMappingService(deps: MappingServiceDeps): MappingService {
  const now = deps.now ?? ((): Date => new Date());

  function require(id: string): MappingRow {
    const row = deps.mappings.findById(id);
    if (row === null) throw AppError.notFound(`No mapping with id ${id}.`);
    return row;
  }

  return {
    list(query: SearchQuery): MappingsResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.mappings.listOrdered();
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.pattern, row.replacement, row.description].some(
            (value) => value !== null && value.toLowerCase().includes(needle),
          ),
        );
      }
      const sorted = sortRows(rows, query, SORTERS, (row) => row.id);
      return paginate(sorted.map(toMapping), offsetOf(query.cursor), query.limit);
    },

    get(id: string): ModelMappingRule {
      return toMapping(require(id));
    },

    create(input: MappingInput): ModelMappingRule {
      const at = now().toISOString();
      return toMapping(
        deps.mappings.create({
          id: crypto.randomUUID(),
          match: input.match,
          pattern: input.pattern,
          replacement: input.replacement,
          priority: input.priority,
          enabled: input.enabled,
          description: input.description,
          createdAt: at,
          updatedAt: at,
        }),
      );
    },

    update(id: string, patch: MappingUpdate): ModelMappingRule {
      require(id);
      deps.mappings.update(
        id,
        {
          match: patch.match,
          pattern: patch.pattern,
          replacement: patch.replacement,
          priority: patch.priority,
          enabled: patch.enabled,
          description: patch.description,
        },
        now().toISOString(),
      );
      return toMapping(require(id));
    },

    remove(id: string): void {
      require(id);
      deps.mappings.delete(id);
    },

    preview(body: MappingPreviewBody): MappingPreviewResult {
      const rule = { match: body.match, pattern: body.pattern, replacement: body.replacement };
      return {
        results: body.samples.map((sample) => {
          const output = applyRule(rule, sample);
          return output === null
            ? { input: sample, output: sample, matched: false }
            : { input: sample, output, matched: true };
        }),
      };
    },
  };
}
