import type { ModelObject, ModelsResponse } from '@contracts';
import type { ProviderRegistry } from '@registry';

import type { AliasesRepository } from '@server/persistence/aliases.ts';
import type { CombosRepository } from '@server/persistence/combos.ts';

import type { Planner } from './plan.ts';

/**
 * The `/v1/models` payload (FR-1.1).
 *
 * What a client can ask for is not the same question as what a provider serves,
 * and C5b is what makes the two differ. The listing therefore has three parts:
 * every curated model, every enabled alias that resolves to something, and every
 * enabled combo.
 *
 * The three carry different amounts of information, and the difference is honest
 * rather than tidy:
 *
 *   - a **curated model** carries the full `rutekit` block, and its `alias` field
 *     names an alias pointing at it when one does — so a client that discovered
 *     `gpt-4o-mini` learns that `fast` also reaches it;
 *   - an **alias** gets its own row, because a client has to be able to discover
 *     the name it was told to use, with the same block describing what it lands
 *     on — unless it lands on a combo, which has no block to copy;
 *   - a **combo** gets a row with no `rutekit` block. It has no single provider
 *     and no single context window or capability set, so filling one in would be
 *     a claim rutekit cannot support. `owned_by` is `rutekit` itself, which is
 *     the one thing that is true of every combo.
 *
 * An alias is listed by asking the planner what it resolves to, rather than by
 * looking its target up in the catalogue. That is the point: an alias pointing at
 * a combo lists correctly, and the listing can never disagree with what a turn
 * would actually do.
 */

/** `owned_by` for a combo: the chain is rutekit's construct, not a provider's. */
const RUTEKIT_OWNER = 'rutekit';

export interface ModelListing {
  list(): ModelsResponse;
}

export interface ModelListingDeps {
  readonly registry: ProviderRegistry;
  readonly planner: Planner;
  readonly aliases: AliasesRepository;
  readonly combos: CombosRepository;
  /** Injectable so the `created` stamp on the listing is assertable. */
  readonly now?: () => Date;
}

export function createModelListing(deps: ModelListingDeps): ModelListing {
  const now = deps.now ?? ((): Date => new Date());

  return {
    list(): ModelsResponse {
      // One stamp for the whole listing rather than a clock read per row: the
      // field means "when rutekit started serving this catalogue", and a list
      // whose rows disagree by milliseconds is noise.
      const created = Math.floor(now().getTime() / 1000);
      const data: ModelObject[] = [];
      const aliases = deps.aliases.listAll().filter((row) => row.enabled);

      for (const manifest of deps.registry.all()) {
        for (const model of manifest.models) {
          const named = aliases.find((row) => row.target === model.id);
          data.push({
            id: model.id,
            object: 'model',
            created,
            owned_by: manifest.id,
            rutekit: {
              providerId: manifest.id,
              alias: named?.alias ?? null,
              contextWindow: model.contextWindow,
              capabilities: { ...model.capabilities },
            },
          });
        }
      }

      for (const alias of aliases) {
        const plan = deps.planner.resolve(alias.alias);
        const step = plan?.steps[0];
        // An alias whose target nothing serves is not a name a client can use, so
        // listing it would advertise a model that answers 404.
        if (plan === null || step === undefined) continue;
        if (plan.via === 'combo') {
          data.push({
            id: alias.alias,
            object: 'model',
            created,
            owned_by: RUTEKIT_OWNER,
          });
          continue;
        }
        data.push({
          id: alias.alias,
          object: 'model',
          created,
          owned_by: step.resolved.providerId,
          rutekit: {
            providerId: step.resolved.providerId,
            alias: alias.alias,
            contextWindow: step.resolved.model.contextWindow,
            capabilities: { ...step.resolved.model.capabilities },
          },
        });
      }

      for (const found of deps.combos.listAll()) {
        if (!found.combo.enabled) continue;
        data.push({
          id: found.combo.name,
          object: 'model',
          created,
          owned_by: RUTEKIT_OWNER,
        });
      }

      return { object: 'list', data };
    },
  };
}
