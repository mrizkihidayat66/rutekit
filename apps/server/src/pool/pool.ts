import type { Logger } from 'pino';
import type { LoadBalanceStrategy } from '@contracts';

import type { ProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';
import type { AccountCredential } from '@server/providers/credential.ts';
import { readCredential } from '@server/providers/credential.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import { createOutcomeWriter, outcomeFromError } from './outcome.ts';
import { selectAccount, type Candidate } from './selection.ts';
import { isAutomatic, isRoutable, parseAccountState } from './state-machine.ts';

/**
 * The account pool (FR-3.1–3.4, ADR-0020).
 *
 * This is the one place that decides which credential a turn is sent as, and the
 * one place that decides an account is no longer fit to send one. `dispatcher.ts`
 * used to pick the first active account and said so in a comment; that comment
 * named this file as the thing that would replace it.
 *
 * Two counts matter and they are not the same count. The **cursor** is per
 * provider and survives across turns — it is what makes round-robin rotate
 * instead of always choosing the same account. The **in-flight count** is per
 * account and lives only here, in memory: a request cannot outlive the process
 * that sent it, so a count read back from disk after a restart would be a count
 * of requests that no longer exist. The column is written as a mirror for an
 * operator reading the database by hand, and nothing in rutekit reads it back.
 *
 * A lease is settled exactly once. `succeed` and `fail` are both idempotent
 * because a stream can die after its headers arrived, which leaves the caller
 * holding a lease that has already been counted as used — and double-counting a
 * release would leak capacity that never comes back.
 */

export interface AccountLease {
  readonly accountId: string;
  readonly credential: AccountCredential;
  /** The turn came back. Clears the failure streak and stamps the use. */
  succeed(): void;
  /** The turn did not come back. Classified, and the account may be parked. */
  fail(error: unknown): void;
}

export interface Pool {
  /**
   * A credential to send the turn as, or null when this provider has none that
   * can take one right now. Null is not an error: a provider whose accounts are
   * all cooling is a provider that is busy, and the caller decides what to say.
   */
  acquire(providerId: string): AccountLease | null;
  /** The live count for one account, for the console. */
  inFlight(accountId: string): number;
  /** Bring back accounts whose clock has run out (FR-3.3). */
  sweep(): void;
}

export interface PoolDeps {
  readonly accounts: ProviderAccountsRepository;
  readonly secrets: SecretBox | null;
  readonly strategy: () => LoadBalanceStrategy;
  readonly logger: Logger;
  readonly now?: () => Date;
}

interface Usable {
  readonly id: string;
  readonly maxInFlight: number;
  readonly credential: AccountCredential;
}

export function createPool(deps: PoolDeps): Pool {
  const now = deps.now ?? ((): Date => new Date());
  const live = new Map<string, number>();
  const cursors = new Map<string, number>();
  const writer = createOutcomeWriter({ accounts: deps.accounts, logger: deps.logger, now });

  function countOf(accountId: string): number {
    return live.get(accountId) ?? 0;
  }

  /** Move the count and mirror it. The map is the truth; the column is a copy. */
  function setLive(accountId: string, next: number): void {
    if (next <= 0) live.delete(accountId);
    else live.set(accountId, next);
    deps.accounts.setInFlight(accountId, Math.max(0, next));
  }

  /** The rows that could take a turn right now, with their credentials already read. */
  function usable(providerId: string): Usable[] {
    const found: Usable[] = [];
    for (const row of deps.accounts.listByProvider(providerId)) {
      const state = parseAccountState(row.state);
      if (state === null || !isRoutable(state)) continue;
      const credential = readCredential(deps.secrets, row);
      // A row whose envelope will not decrypt is skipped rather than fatal, the
      // same reading the pre-pool dispatcher took: one broken account among
      // several is not a reason to refuse the turn.
      if (credential === null) continue;
      found.push({ id: row.id, maxInFlight: row.maxInFlight, credential });
    }
    return found;
  }

  return {
    acquire(providerId: string): AccountLease | null {
      const found = usable(providerId);
      const candidates: Candidate[] = found.map((entry) => ({
        id: entry.id,
        inFlight: countOf(entry.id),
        maxInFlight: entry.maxInFlight,
      }));

      const choice = selectAccount(candidates, deps.strategy(), cursors.get(providerId) ?? 0);
      if (choice === null) return null;
      const picked = found.find((entry) => entry.id === choice.accountId);
      if (picked === undefined) return null;

      cursors.set(providerId, choice.cursor);
      setLive(picked.id, countOf(picked.id) + 1);

      let settled = false;
      const release = (): boolean => {
        if (settled) return false;
        settled = true;
        setLive(picked.id, countOf(picked.id) - 1);
        return true;
      };

      return {
        accountId: picked.id,
        credential: picked.credential,
        succeed(): void {
          if (!release()) return;
          deps.accounts.recordSuccess(picked.id, now().toISOString());
        },
        fail(error: unknown): void {
          if (!release()) return;
          writer.apply(picked.id, outcomeFromError(error, now()));
        },
      };
    },

    inFlight(accountId: string): number {
      return countOf(accountId);
    },

    sweep(): void {
      const at = now().getTime();
      for (const row of deps.accounts.listAll()) {
        const state = parseAccountState(row.state);
        if (state === null) continue;

        if (state === 'rate_limited' && row.cooldownUntil !== null) {
          if (Date.parse(row.cooldownUntil) <= at && isAutomatic(state, 'active')) {
            deps.accounts.setState(row.id, 'active', 'Cooldown elapsed.', null, now().toISOString());
          }
          continue;
        }

        // `exhausted` with no `quotaResetAt` is waiting on the provider's window,
        // which only a check-in can observe; the sweep has no clock to read.
        if (state === 'exhausted' && row.quotaResetAt !== null) {
          if (Date.parse(row.quotaResetAt) <= at && isAutomatic(state, 'active')) {
            deps.accounts.setState(row.id, 'active', 'Quota window reset.', null, now().toISOString());
          }
        }
      }
    },
  };
}
