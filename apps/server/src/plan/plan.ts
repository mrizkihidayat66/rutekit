import { mappingMatchSchema } from '@contracts';
import type { CanonicalRequest } from '@translator';
import type { RandomSource } from '@shared';

import type { AliasRow, AliasesRepository } from '@server/persistence/aliases.ts';
import type { ComboWithEntries, CombosRepository } from '@server/persistence/combos.ts';
import type { MappingsRepository } from '@server/persistence/mappings.ts';
import type { ModelCatalog, ResolvedModel } from '@server/providers/model-catalog.ts';

import {
  demandsOf,
  isChatIncapable,
  unmetBy,
  type ControlKind,
} from './capability.ts';
import { rewriteModel, type MappingRule } from './mapping.ts';
import { orderChain, parseStrategy, type WeightedEntry } from './order.ts';

/**
 * What a client's model name actually means (C5b/C5c, FR-1.3–1.6).
 *
 * Two questions, answered in two steps, and the split is the whole design.
 *
 * **`resolve(modelId)`** answers "which models does this name reach?" — a pure
 * function of the stored plan, needing nothing from the request. That is what the
 * `/v1/models` listing asks, and what an operator means when they say a combo
 * points at three models.
 *
 * **`resolveFor(modelId, request)`** answers "which models can actually serve
 * *this* request, best first?" — the same candidates, reordered by what the
 * request needs and annotated with what each one would have to drop (FR-1.6).
 *
 * Keeping them apart is what makes capability-aware routing honest. The listing
 * must not change based on what a client happens to be sending, and the
 * dispatcher must not have to reason about capabilities itself. The reordering
 * lives in `rank` below and nowhere else.
 *
 * The name resolution order is fixed and documented in ADR-0021:
 *
 *   1. **mapping** rewrites the id at the edge (FR-1.5) — the only step that can
 *      change the *question*.
 *   2. **alias** resolves a friendly name to a target (FR-1.3). One hop, never a
 *      chain.
 *   3. **combo** fans the target out into an ordered chain (FR-1.4).
 *   4. otherwise the id is a model id, and the catalogue answers.
 *
 * Every read is from the database, on every turn: there is no snapshot to
 * invalidate, so a rule saved on the console is in force on the next turn.
 *
 * Nothing here throws on bad stored data. An unparsable regex, a combo entry
 * naming a model nothing serves, a strategy column holding something the contract
 * no longer describes — each is a reason to skip one record, never a reason to
 * fail the turn (R5.5's fail-open reading, applied to the plan).
 */

/** One candidate a name reaches, before anything is known about the request. */
export interface PlanStep {
  readonly resolved: ResolvedModel;
}

/** A candidate, with what it would cost to use it for one particular request. */
export interface RankedStep extends PlanStep {
  /**
   * Controls this model cannot express, which would be dropped or replaced to
   * send the request here. Empty means the model expresses everything asked for.
   */
  readonly degraded: readonly ControlKind[];
}

/** How the plan was arrived at. Reported so a turn can be explained. */
export type PlanVia = 'model' | 'alias' | 'combo';

/** The models a client's name reaches, best first. Independent of any request. */
export interface ModelCandidates {
  /** The id the client sent. */
  readonly requested: string;
  /** The id after edge rewriting, which is what the alias and combo lookups saw. */
  readonly rewritten: string;
  readonly via: PlanVia;
  readonly comboId: string | null;
  readonly comboName: string | null;
  /**
   * Whether a failure on one step may be retried on the next. Only a combo can
   * say yes, and only while nothing has been committed to the client yet — see
   * `dispatcher.ts`.
   */
  readonly fallbackOnError: boolean;
  /**
   * Candidates, best first. Empty when a combo matched but none of its entries
   * named a model that exists, which is a configuration fault the caller reports
   * rather than a 404 on the requested id.
   */
  readonly steps: readonly PlanStep[];
  /** Combo entries that named no known model, so the caller can say so. */
  readonly unresolved: readonly string[];
}

/**
 * The candidates that can serve one request, with the cost of each.
 *
 * A model the request cannot fit at all — an embedding model asked for a chat
 * turn — is not a step with everything degraded; it is not a step. Nothing can be
 * dropped to turn a chat request into an embedding request, so `refused` names
 * them and the dispatcher decides what to say.
 */
export interface TurnPlan extends ModelCandidates {
  readonly steps: readonly RankedStep[];
  /** Candidates that cannot serve this request under any degradation. */
  readonly refused: readonly string[];
}

export interface Planner {
  /** The plan for `modelId`, or null when nothing in rutekit answers to it. */
  resolve(modelId: string): ModelCandidates | null;
  /** The same plan, ranked for this request and annotated with what it costs. */
  resolveFor(modelId: string, request: CanonicalRequest): TurnPlan | null;
}

export interface PlannerDeps {
  readonly catalog: ModelCatalog;
  readonly aliases: AliasesRepository;
  readonly combos: CombosRepository;
  readonly mappings: MappingsRepository;
  /**
   * Whether the instance is in low-stress mode (FR-12.2).
   *
   * Read per turn rather than captured at boot, so flipping the switch on the
   * dashboard takes effect on the next request instead of the next restart — the
   * same rule the pool's strategy follows.
   */
  readonly lowStress: () => boolean;
  /** Injectable so a test can pin a weighted combo's head. */
  readonly random: RandomSource;
}

export function createPlanner(deps: PlannerDeps): Planner {
  /** Only the enabled rules run, and `listOrdered` has already sorted them. */
  function activeRules(): MappingRule[] {
    const rules: MappingRule[] = [];
    for (const row of deps.mappings.listOrdered()) {
      if (!row.enabled) continue;
      // The column is written only from the contract's enum, so an unreadable
      // one means the row was edited outside rutekit; skipping it is the safe
      // reading, and a rule that cannot be read must not match.
      const match = mappingMatchSchema.safeParse(row.match);
      if (!match.success) continue;
      rules.push({
        id: row.id,
        match: match.data,
        pattern: row.pattern,
        replacement: row.replacement,
      });
    }
    return rules;
  }

  function comboPlan(
    requested: string,
    rewritten: string,
    found: ComboWithEntries,
  ): ModelCandidates {
    const steps: WeightedEntry<ResolvedModel>[] = [];
    const unresolved: string[] = [];

    for (const entry of found.entries) {
      if (!entry.enabled) continue;
      const resolved = deps.catalog.resolve(entry.model, entry.providerId);
      // An entry naming a model no provider serves is dropped rather than
      // refused: one stale row in a five-entry chain should cost that row, not
      // the whole combo. What it costs is visibility — `unresolved` names them.
      if (resolved === null) {
        unresolved.push(entry.model);
        continue;
      }
      steps.push({ value: resolved, weight: entry.weight });
    }

    const ordered = orderChain(steps, parseStrategy(found.combo.strategy), deps.random);
    return {
      requested,
      rewritten,
      via: 'combo',
      comboId: found.combo.id,
      comboName: found.combo.name,
      fallbackOnError: found.combo.fallbackOnError,
      steps: ordered.map((resolved) => ({ resolved })),
      unresolved,
    };
  }

  function resolve(modelId: string): ModelCandidates | null {
    const rewritten = rewriteModel(activeRules(), modelId).modelId;

    const alias = enabledAlias(deps.aliases, rewritten);
    const target = alias?.target ?? rewritten;

    const combo = deps.combos.findByName(target);
    if (combo !== null && combo.combo.enabled) {
      // A combo is looked up by the post-alias target, so an alias naming a
      // combo lands here; the alias's own provider pin is not carried, because
      // a chain that spans providers has no single one to pin.
      return comboPlan(modelId, rewritten, combo);
    }

    const resolved = deps.catalog.resolve(target, alias?.providerId ?? null);
    if (resolved === null) return null;
    return {
      requested: modelId,
      rewritten,
      via: alias === null ? 'model' : 'alias',
      comboId: null,
      comboName: null,
      fallbackOnError: false,
      steps: [{ resolved }],
      unresolved: [],
    };
  }

  return {
    resolve,

    resolveFor(modelId: string, request: CanonicalRequest): TurnPlan | null {
      const candidates = resolve(modelId);
      if (candidates === null) return null;
      return rank(candidates, demandsOf(request), deps.lowStress());
    },
  };
}

/**
 * Reorder the candidates by what the request needs, and say what each would cost.
 *
 * Two ordering rules, applied in this order:
 *
 *   1. **Fitness.** A candidate that can express everything asked for beats one
 *      that cannot. This is C5c's rule and it is absolute — no price makes a
 *      model that would have to drop the client's image worth trying first.
 *   2. **Price, but only in low-stress mode.** With the switch on, equally fit
 *      candidates are ordered by the manifest's input price, cheapest first. With
 *      it off, the operator's own order stands.
 *
 * Both reorders are stable, so among candidates that tie on every key the chain
 * keeps exactly the order it was written in. That matters most for the second
 * rule: a combo whose entries all cost the same is a combo the operator ordered
 * deliberately, and low-stress mode must not shuffle it.
 *
 * **Low-stress never picks a model outside the chain.** It reorders what the plan
 * already contains and nothing more — the same boundary C5c draws. A cheaper
 * model the operator did not list is not a candidate, and reaching for one would
 * be the silent substitution FR-1.6 forbids.
 *
 * The incapable candidates stay in the list rather than being filtered out. That
 * is the C5c decision: dropping them would throw away real availability, and a
 * chain whose best candidate fails upstream should still be able to fall back to
 * a model that answers with the image replaced by a placeholder, rather than
 * failing the turn outright. What must never happen is a silent swap — and it
 * cannot, because every step carries its `degraded` list and the dispatcher
 * reports it.
 */
function rank(
  candidates: ModelCandidates,
  demands: readonly ControlKind[],
  lowStress: boolean,
): TurnPlan {
  const steps: RankedStep[] = [];
  const refused: string[] = [];

  for (const step of candidates.steps) {
    if (isChatIncapable(step.resolved.model.capabilities)) {
      refused.push(step.resolved.model.id);
      continue;
    }
    steps.push({
      resolved: step.resolved,
      degraded: unmetBy(step.resolved.model.capabilities, demands),
    });
  }

  const capable = steps.filter((step) => step.degraded.length === 0);
  const degraded = steps.filter((step) => step.degraded.length > 0);
  if (!lowStress) return { ...candidates, steps: [...capable, ...degraded], refused };

  // `sort` is stable in every engine rutekit runs on, so entries with equal price
  // keep their stated order — the property that makes this a reorder and not a
  // reshuffle.
  const cheapestFirst = (left: RankedStep, right: RankedStep): number =>
    inputPrice(left) - inputPrice(right);

  return {
    ...candidates,
    steps: [...capable.sort(cheapestFirst), ...degraded.sort(cheapestFirst)],
    refused,
  };
}

/**
 * A candidate's input price, with "unpriced" sorted last.
 *
 * `Infinity` rather than 0 for a model the manifest does not price: a locally
 * hosted model is free and an unlearned one is unknown, and treating the unknown
 * as the cheapest would make low-stress mode prefer exactly the models it knows
 * least about. Sorting them last is the conservative reading.
 */
function inputPrice(step: RankedStep): number {
  return step.resolved.model.inputPricePerMTok ?? Number.POSITIVE_INFINITY;
}

/** The enabled alias by that name, or null. A disabled one is not a name at all. */
function enabledAlias(aliases: AliasesRepository, name: string): AliasRow | null {
  const row = aliases.findByAlias(name);
  return row !== null && row.enabled ? row : null;
}
