import type { Alias, AliasInput, AliasUpdate, AliasesResponse, SearchQuery } from '@contracts';

import { AppError } from '@server/errors.ts';
import type { AliasRow, AliasesRepository } from '@server/persistence/aliases.ts';

import { offsetOf, paginate, sortRows } from './list.ts';

/**
 * Aliases (FR-1.3).
 *
 * Like a combo, the name is written once: the console disables the field on an
 * existing alias, because the name is what a client sends and moving it is not an
 * edit. What an alias *points at* is the editable half, and that is the whole
 * point of having one — a client that cannot be changed keeps sending `fast`
 * while `fast` is repointed.
 *
 * The name is also checked for uniqueness on create rather than letting the
 * unique index throw. The index is still the guarantee — a check followed by an
 * insert is not atomic, and two concurrent creates could both pass it — but the
 * check is what turns the common case into a sentence an operator can read
 * instead of a driver error.
 */

export interface AliasService {
  list(query: SearchQuery): AliasesResponse;
  get(id: string): Alias;
  create(input: AliasInput): Alias;
  update(id: string, patch: AliasUpdate): Alias;
  remove(id: string): void;
}

export interface AliasServiceDeps {
  readonly aliases: AliasesRepository;
  readonly now?: () => Date;
}

export function toAlias(row: AliasRow): Alias {
  return {
    id: row.id,
    alias: row.alias,
    target: row.target,
    providerId: row.providerId,
    enabled: row.enabled,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SORTERS: Record<string, (row: AliasRow) => string> = {
  alias: (row) => row.alias.toLowerCase(),
  target: (row) => row.target.toLowerCase(),
  createdAt: (row) => row.createdAt,
  updatedAt: (row) => row.updatedAt,
};

export function createAliasService(deps: AliasServiceDeps): AliasService {
  const now = deps.now ?? ((): Date => new Date());

  function require(id: string): AliasRow {
    const row = deps.aliases.findById(id);
    if (row === null) throw AppError.notFound(`No alias with id ${id}.`);
    return row;
  }

  return {
    list(query: SearchQuery): AliasesResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.aliases.listAll();
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.alias, row.target, row.description].some(
            (value) => value !== null && value.toLowerCase().includes(needle),
          ),
        );
      }
      const sorted = sortRows(rows, query, SORTERS, (row) => row.id);
      return paginate(sorted.map(toAlias), offsetOf(query.cursor), query.limit);
    },

    get(id: string): Alias {
      return toAlias(require(id));
    },

    create(input: AliasInput): Alias {
      if (deps.aliases.findByAlias(input.alias) !== null) {
        throw AppError.invalidRequest(`An alias named ${input.alias} already exists.`);
      }
      const at = now().toISOString();
      return toAlias(
        deps.aliases.create({
          id: crypto.randomUUID(),
          alias: input.alias,
          target: input.target,
          providerId: input.providerId,
          enabled: input.enabled,
          description: input.description,
          createdAt: at,
          updatedAt: at,
        }),
      );
    },

    update(id: string, patch: AliasUpdate): Alias {
      const current = require(id);
      // Same rule as a combo's name, and the console's alias dialog says so in as
      // many words: the name is what a client sends, so it is fixed once the alias
      // exists. Repointing the target is the editable half.
      if (patch.alias !== undefined && patch.alias !== current.alias) {
        throw AppError.invalidRequest(
          'An alias name is fixed once it exists. Create a new alias and disable this one.',
        );
      }
      deps.aliases.update(
        id,
        {
          target: patch.target,
          providerId: patch.providerId,
          enabled: patch.enabled,
          description: patch.description,
        },
        now().toISOString(),
      );
      return toAlias(require(id));
    },

    remove(id: string): void {
      require(id);
      deps.aliases.delete(id);
    },
  };
}
