import { loadBalanceStrategySchema, type LoadBalanceStrategy } from '@contracts';

import { META_KEYS, type AppMetaRepository } from '@server/persistence/app-meta.ts';

/**
 * How the pool picks among an account's siblings (FR-3.2).
 *
 * The mode belongs to the router, not to a provider: an operator sets it once
 * and every provider obeys it, which is what the console's own Routing Strategy
 * card says about it. So this is one value, stored as one bare `app_meta` row —
 * not a table, not a per-provider column. `loadBalanceStrategySchema` is the same
 * enum the combo editor uses, so there is one vocabulary for "how do we choose"
 * across the whole product rather than two that drift.
 *
 * `round_robin` is the default because it is the behaviour the console already
 * describes: balance across every eligible credential in turn, favouring
 * whichever has the fewest requests in flight. `sequential` exists for the
 * operator who wants their stated order respected — the account they added first
 * is the account that pays — and is deliberately not the default, because a pool
 * that only ever uses one account is not a pool.
 *
 * Reading never throws. A row hand-edited into something the contract no longer
 * describes falls back to the default, the same fail-open rule the Token Saver
 * settings follow: a broken settings row must not be the reason a turn fails.
 */

export const DEFAULT_LOAD_BALANCE_STRATEGY: LoadBalanceStrategy = 'round_robin';

export interface PoolStrategySettings {
  /** The stored mode, or the default when nothing usable is stored. */
  read(): LoadBalanceStrategy;
  /** Replace the mode. Returns what was written. */
  write(strategy: LoadBalanceStrategy): LoadBalanceStrategy;
}

export function createPoolStrategySettings(deps: {
  readonly meta: AppMetaRepository;
}): PoolStrategySettings {
  return {
    read(): LoadBalanceStrategy {
      const parsed = loadBalanceStrategySchema.safeParse(deps.meta.get(META_KEYS.poolStrategy));
      return parsed.success ? parsed.data : DEFAULT_LOAD_BALANCE_STRATEGY;
    },

    write(strategy: LoadBalanceStrategy): LoadBalanceStrategy {
      deps.meta.set(META_KEYS.poolStrategy, strategy);
      return strategy;
    },
  };
}
