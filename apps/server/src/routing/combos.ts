import type { Combo, ComboInput, ComboUpdate, CombosResponse, SearchQuery } from '@contracts';

import { AppError } from '@server/errors.ts';
import type {
  ComboEntryWrite,
  ComboWithEntries,
  CombosRepository,
} from '@server/persistence/combos.ts';
import { parseStrategy } from '@server/plan/order.ts';

import { offsetOf, paginate, sortRows } from './list.ts';

/**
 * Combos & Routes (FR-1.4).
 *
 * `name` is written once and never patched. The console's own dialog says so —
 * the field is disabled on an existing combo — and the reason is that the name is
 * the *interface*: a client sends it, so renaming one is not an edit to a record,
 * it is retiring one name and introducing another. Allowing it here would let a
 * PATCH through the API do silently what the UI deliberately will not.
 *
 * `entries` is replaced wholesale rather than merged. The list's order is its
 * meaning, so a merge would have to renumber anyway, and "send the chain you
 * want" is one instruction instead of a diff protocol the console would have to
 * implement.
 */

export interface ComboService {
  list(query: SearchQuery): CombosResponse;
  get(id: string): Combo;
  create(input: ComboInput): Combo;
  update(id: string, patch: ComboUpdate): Combo;
  remove(id: string): void;
}

export interface ComboServiceDeps {
  readonly combos: CombosRepository;
  readonly now?: () => Date;
}

export function toCombo(found: ComboWithEntries): Combo {
  return {
    id: found.combo.id,
    name: found.combo.name,
    displayName: found.combo.displayName,
    description: found.combo.description,
    // Read through the same fail-open parser the planner uses, so a column
    // hand-edited into something the contract no longer describes cannot make the
    // console show a value the resolver would never act on.
    strategy: parseStrategy(found.combo.strategy),
    entries: found.entries.map((entry) => ({
      id: entry.id,
      model: entry.model,
      providerId: entry.providerId,
      weight: entry.weight,
      enabled: entry.enabled,
    })),
    fallbackOnError: found.combo.fallbackOnError,
    enabled: found.combo.enabled,
    createdAt: found.combo.createdAt,
    updatedAt: found.combo.updatedAt,
  };
}

function toEntryWrites(entries: ComboInput['entries']): ComboEntryWrite[] {
  return entries.map((entry) => ({
    model: entry.model,
    providerId: entry.providerId,
    weight: entry.weight,
    enabled: entry.enabled,
  }));
}

/** The columns the console offers as sort keys. */
const SORTERS: Record<string, (found: ComboWithEntries) => string> = {
  name: (found) => found.combo.name.toLowerCase(),
  displayName: (found) => found.combo.displayName.toLowerCase(),
  strategy: (found) => found.combo.strategy,
  createdAt: (found) => found.combo.createdAt,
  updatedAt: (found) => found.combo.updatedAt,
};

export function createComboService(deps: ComboServiceDeps): ComboService {
  const now = deps.now ?? ((): Date => new Date());

  function require(id: string): ComboWithEntries {
    const found = deps.combos.findById(id);
    if (found === null) throw AppError.notFound(`No combo with id ${id}.`);
    return found;
  }

  return {
    list(query: SearchQuery): CombosResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.combos.listAll();
      if (needle !== '') {
        rows = rows.filter((found) =>
          [found.combo.name, found.combo.displayName, found.combo.description].some(
            (value) => value !== null && value.toLowerCase().includes(needle),
          ),
        );
      }
      const sorted = sortRows(rows, query, SORTERS, (found) => found.combo.id);
      const offset = offsetOf(query.cursor);
      return paginate(sorted.map(toCombo), offset, query.limit);
    },

    get(id: string): Combo {
      return toCombo(require(id));
    },

    create(input: ComboInput): Combo {
      if (deps.combos.findByName(input.name) !== null) {
        throw AppError.invalidRequest(`A combo named ${input.name} already exists.`);
      }
      const at = now().toISOString();
      const found = deps.combos.create(
        {
          id: crypto.randomUUID(),
          name: input.name,
          displayName: input.displayName,
          description: input.description,
          strategy: input.strategy,
          fallbackOnError: input.fallbackOnError,
          enabled: input.enabled,
          createdAt: at,
          updatedAt: at,
        },
        toEntryWrites(input.entries),
      );
      return toCombo(found);
    },

    update(id: string, patch: ComboUpdate): Combo {
      const current = require(id);
      // The console disables the name field on an existing combo and sends the
      // same one back, so a *different* name here is somebody driving the API by
      // hand. Refusing is the honest answer: silently ignoring it would look like
      // a successful rename.
      if (patch.name !== undefined && patch.name !== current.combo.name) {
        throw AppError.invalidRequest(
          'A combo name is fixed once it exists. Create a new combo and disable this one.',
        );
      }
      const at = now().toISOString();
      deps.combos.update(
        id,
        {
          displayName: patch.displayName,
          description: patch.description,
          strategy: patch.strategy,
          fallbackOnError: patch.fallbackOnError,
          enabled: patch.enabled,
        },
        at,
      );
      // Only a body that carried entries replaces the chain. `updateSchema` drops
      // every default, so an absent `entries` is genuinely absent and means
      // "leave the chain alone" rather than "empty it".
      if (patch.entries !== undefined) {
        deps.combos.replaceEntries(id, toEntryWrites(patch.entries));
      }
      return toCombo(require(id));
    },

    remove(id: string): void {
      require(id);
      deps.combos.delete(id);
    },
  };
}
