import { RECOVERABLE_ACCOUNT_STATES, type Account, type ProviderModel } from '@contracts';

import { cooldownSeconds } from '@web/components/patterns/account-state.ts';

/**
 * The Provider Detail page's vocabulary.
 *
 * Everything here is a pure derivation over the detail payload. The page and its
 * cards must not each invent their own idea of what "cooling" or "routable"
 * means, or the stat strip and the account table will quietly disagree about the
 * same pool. Nothing here renders, so any of the page's components can import it
 * without breaking fast refresh.
 *
 * Two things this file used to own now live in `components/patterns/`, because
 * the Model Catalog needs them too: `cooldownSeconds` (shared with the Accounts
 * page) in `account-state.ts`, and the source/price vocabulary in
 * `model-vocabulary.ts`.
 */

/** What the pool behind one provider is actually able to do right now. */
export interface AccountBreakdown {
  readonly total: number;
  /** Accounts the router will actually route to (contracts: `ROUTABLE_ACCOUNT_STATES`). */
  readonly routable: number;
  readonly inFlight: number;
  readonly capacity: number;
  readonly cooling: number;
  readonly recovering: number;
  /** Switched off, banned, or awaiting a first check-in. */
  readonly parked: number;
}

export function accountBreakdown(accounts: readonly Account[], nowMs: number): AccountBreakdown {
  let routable = 0;
  let inFlight = 0;
  let capacity = 0;
  let cooling = 0;
  let recovering = 0;
  let parked = 0;

  for (const account of accounts) {
    if (account.state === 'active') {
      routable += 1;
      inFlight += account.inFlight;
      capacity += account.maxInFlight;
      continue;
    }
    if (cooldownSeconds(account, nowMs) !== null) {
      cooling += 1;
      continue;
    }
    if (RECOVERABLE_ACCOUNT_STATES.includes(account.state)) {
      recovering += 1;
      continue;
    }
    parked += 1;
  }

  return { total: accounts.length, routable, inFlight, capacity, cooling, recovering, parked };
}

/** How many of the advertised models carry a capability, for the stat tile. */
export interface ModelTally {
  readonly total: number;
  readonly deprecated: number;
  readonly vision: number;
}

export function modelTally(models: readonly ProviderModel[]): ModelTally {
  let deprecated = 0;
  let vision = 0;
  for (const model of models) {
    if (model.deprecated) deprecated += 1;
    if (model.capabilities.vision) vision += 1;
  }
  return { total: models.length, deprecated, vision };
}

/**
 * Models in the order an operator wants to read them.
 *
 * A deprecated model is still listed — it is often exactly the one a client is
 * still calling — but it is never allowed to sit above a usable model, so the
 * table sorts by that first and alphabetically within each group.
 */
export function sortModels(models: readonly ProviderModel[]): ProviderModel[] {
  return [...models].sort((left, right) => {
    if (left.deprecated !== right.deprecated) return left.deprecated ? 1 : -1;
    return left.displayName.localeCompare(right.displayName);
  });
}
