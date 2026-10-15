import { useMutation, useQueryClient } from '@tanstack/react-query';

import { createMapping, deleteMapping, updateMapping } from '@web/data/routing.ts';

import { planSize, type RulesetPlan } from './ruleset.ts';

/**
 * Apply a whole edited ruleset.
 *
 * The console API has no bulk endpoint — one rule per request — so this is one
 * mutation that happens to make several calls, rather than several mutations
 * fired together. The difference matters: an operator who pastes a ruleset and
 * presses Apply is making one decision, and it should report as one thing.
 *
 * The calls run in sequence rather than in parallel. They are configuration
 * writes against one list, the mock server serialises them anyway, and a
 * sequential run is the only way the progress count means anything — "3 of 7"
 * with seven requests in flight would be a lie.
 *
 * Invalidation happens once at the end rather than per call. Each rule write
 * would otherwise invalidate the list, and a ruleset of thirty rules would
 * refetch it thirty times.
 */

export interface ApplyRulesetVars {
  readonly plan: RulesetPlan;
  readonly onProgress?: (done: number, total: number) => void;
}

export function useApplyRuleset() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async ({ plan, onProgress }: ApplyRulesetVars) => {
      const total = planSize(plan);
      let done = 0;
      const tick = () => {
        done += 1;
        onProgress?.(done, total);
      };

      for (const input of plan.creates) {
        await createMapping(input);
        tick();
      }
      for (const { id, patch } of plan.updates) {
        await updateMapping(id, patch);
        tick();
      }
      for (const id of plan.deletes) {
        await deleteMapping(id);
        tick();
      }
      return total;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['mappings', 'list'] });
    },
  });
}
