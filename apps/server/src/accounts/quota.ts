import type { QuotaOverview, QuotaRow } from '@contracts';
import type { ProviderRegistry } from '@registry';

import type { ProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';
import type { Warmup } from '@server/pool/warmup.ts';

/**
 * The quota page's read model (FR-3.6).
 *
 * What a provider told us about its own limits, summed across the accounts
 * rutekit holds for it. The rows are grouped by `windowSeconds` because that is
 * what the figures are: a provider's daily allowance is one budget no matter how
 * many credentials are drawing on it, and adding a per-minute window to a daily
 * one would be adding two different units together.
 *
 * A provider with no accounts is left out. It has no quota to report, and a row
 * of zeros would read as "exhausted" rather than "nothing to ask".
 *
 * Nothing here computes a check-in. `checkIn` starts one and returns at once: a
 * sweep is a network round trip per account, and the console already polls this
 * same read until the `checking` flag clears. Holding the POST open for the
 * slowest provider in the catalogue would be a request that outlives its page.
 */

export interface QuotaService {
  overview(): QuotaOverview;
  /** Start a check-in for these providers (all of them when empty) and report it. */
  checkIn(providerIds: readonly string[]): QuotaOverview;
}

export interface QuotaServiceDeps {
  readonly registry: ProviderRegistry;
  readonly accounts: ProviderAccountsRepository;
  readonly warmup: Warmup;
}

/** One window's running total while the accounts are walked. */
interface WindowTotal {
  limit: number;
  remaining: number;
  resetAt: string | null;
}

export function createQuotaService(deps: QuotaServiceDeps): QuotaService {
  function overview(): QuotaOverview {
    const checking = deps.warmup.checking();
    const rows: QuotaRow[] = [];

    for (const manifest of deps.registry.all()) {
      const accounts = deps.accounts.listByProvider(manifest.id);
      if (accounts.length === 0) continue;

      const windows = new Map<number, WindowTotal>();
      for (const account of accounts) {
        const { quotaWindowSeconds, quotaLimit } = account;
        if (quotaWindowSeconds === null || quotaLimit === null) continue;
        const total = windows.get(quotaWindowSeconds) ?? {
          limit: 0,
          remaining: 0,
          resetAt: account.quotaResetAt,
        };
        total.limit += quotaLimit;
        total.remaining += account.quotaRemaining ?? 0;
        windows.set(quotaWindowSeconds, total);
      }

      rows.push({
        providerId: manifest.id,
        providerName: manifest.name,
        windows: [...windows.entries()].map(([windowSeconds, total]) => ({
          windowSeconds,
          limit: total.limit,
          remaining: total.remaining,
          resetAt: total.resetAt,
        })),
        // No provider in the catalogue publishes a credit pool and there is no
        // table that could hold one, so this is empty rather than missing.
        creditPools: [],
        lastCheckedAt: deps.warmup.lastCheckedAt() ?? accounts[0]?.lastUsedAt ?? null,
        checking: checking.has(manifest.id),
      });
    }

    return { rows, nextSweepInSeconds: deps.warmup.nextSweepInSeconds() };
  }

  return {
    overview,

    checkIn(providerIds: readonly string[]): QuotaOverview {
      // Not awaited: the sweep marks its targets as `checking` before its first
      // await, so the overview read on the next line already reports them, and
      // the console polls until they clear.
      void deps.warmup.checkIn(providerIds.length === 0 ? undefined : providerIds);
      return overview();
    },
  };
}
