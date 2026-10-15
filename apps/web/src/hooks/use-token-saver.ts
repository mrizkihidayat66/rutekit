import type { TimeWindow, TokenSaverConfig, TokenSaverConfigUpdate } from '@contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@web/data/query-keys.ts';
import {
  fetchTokenSaverConfig,
  fetchTokenSaverSavings,
  updateTokenSaverConfig,
} from '@web/data/token-saver.ts';

/**
 * The Token Saver page's hooks.
 *
 * The settings are written optimistically for the same reason the appearance
 * record is: a switch, a preset and a filter toggle all read as immediate
 * actions, and waiting a round trip for a checkbox to move is the difference
 * between configuring the pipeline and fighting it. A rejected patch rolls the
 * cache back, and every settle re-reads the server so the two cannot drift.
 *
 * The savings are read-only and refetched on a slower cadence, because the
 * figures only move as traffic flows.
 */

/** Configuration only moves when the operator moves it. */
const CONFIG_STALE = 30_000;
/** Savings move with traffic, but a live-looking number is enough. */
const SAVINGS_STALE = 20_000;

/**
 * A patch that may name a field without giving it a value. Zod's `.partial()`
 * produces `field?: T | undefined`, which is not `Partial<T>` once
 * `exactOptionalPropertyTypes` is on; spelling the looser shape out lets the
 * mutation variables pass straight through.
 */
type Patch<T> = { [K in keyof T]?: T[K] | undefined };

function patchIn(client: QueryClient, patch: Patch<TokenSaverConfig>): () => void {
  void client.cancelQueries({ queryKey: queryKeys.tokenSaver() });
  const previous = client.getQueryData<TokenSaverConfig>(queryKeys.tokenSaver());

  if (previous !== undefined) {
    // A patch may name a field without giving it a value, so each one is taken
    // only when it is actually set — spreading the patch would let an
    // `undefined` overwrite the value the control is showing.
    const next: TokenSaverConfig = {
      enabled: patch.enabled ?? previous.enabled,
      stages: { ...previous.stages, ...patch.stages },
      rtkPreset: patch.rtkPreset ?? previous.rtkPreset,
      // The filter map merges key-by-key, mirroring the server: a patch naming
      // one filter must not drop the other eleven.
      rtkFilters: { ...previous.rtkFilters, ...patch.rtkFilters },
      cavemanTier: patch.cavemanTier ?? previous.cavemanTier,
      updatedAt: previous.updatedAt,
    };
    client.setQueryData<TokenSaverConfig>(queryKeys.tokenSaver(), next);
  }

  return () => {
    if (previous !== undefined) client.setQueryData(queryKeys.tokenSaver(), previous);
  };
}

export function useTokenSaverConfig() {
  return useQuery({
    queryKey: queryKeys.tokenSaver(),
    queryFn: ({ signal }) => fetchTokenSaverConfig(signal),
    staleTime: CONFIG_STALE,
  });
}

export function useUpdateTokenSaver() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: TokenSaverConfigUpdate) => updateTokenSaverConfig(patch),
    onMutate: (patch) => patchIn(client, patch),
    onError: (_error, _patch, rollback) => {
      if (typeof rollback === 'function') rollback();
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.tokenSaver() });
      // A stage going on or off changes what the savings can claim.
      void client.invalidateQueries({ queryKey: ['token-saver', 'savings'] });
    },
  });
}

export function useTokenSaverSavings(window: TimeWindow) {
  return useQuery({
    queryKey: queryKeys.tokenSaverSavings(window),
    queryFn: ({ signal }) => fetchTokenSaverSavings(window, signal),
    staleTime: SAVINGS_STALE,
  });
}
