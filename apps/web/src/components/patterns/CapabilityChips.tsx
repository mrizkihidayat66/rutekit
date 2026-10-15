import { MODEL_CAPABILITIES, type ModelCapability } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { cn } from '@web/lib/cn.ts';

/**
 * A model's capability flags as a row of chips.
 *
 * Shared by the two tables that list a model — Provider Detail's and the Model
 * Catalog's — because a model that reads "vision, tools" in one place and
 * "tools, vision" in the other is the same model described twice. The order is
 * fixed by `MODEL_CAPABILITIES` rather than by whatever order the flags happen
 * to be true in, so the chips line up column-wise down the table.
 *
 * A model with no flags renders a dash instead of an empty cell: an operator
 * scanning the column needs to see that the row was read, not skipped.
 */

export interface CapabilityChipsProps {
  readonly capabilities: Record<ModelCapability, boolean>;
  readonly className?: string;
}

export function CapabilityChips({ capabilities, className }: CapabilityChipsProps) {
  const present = MODEL_CAPABILITIES.filter((capability) => capabilities[capability]);
  if (present.length === 0) return <span className="text-text-subtle">—</span>;
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {present.map((capability) => (
        <Badge key={capability} tone="neutral" size="sm">
          {capability}
        </Badge>
      ))}
    </span>
  );
}
