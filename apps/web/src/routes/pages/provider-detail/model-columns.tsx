import { Pencil, Trash2 } from 'lucide-react';

import type { ProviderModel } from '@contracts';

import { CapabilityChips } from '@web/components/patterns/CapabilityChips.tsx';
import type { DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import {
  MODEL_SOURCE_HINTS,
  MODEL_SOURCE_LABELS,
  MODEL_SOURCE_TONES,
  formatPerMTok,
  isEditableModel,
} from '@web/components/patterns/model-vocabulary.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Tooltip } from '@web/components/ui/Tooltip.tsx';
import { formatTokens } from '@web/lib/format.ts';

/**
 * The Models table's columns.
 *
 * Built as a function rather than declared as a constant because the last column
 * is about what an operator may do to the row, not about the row itself: only an
 * entry added by hand can be edited or removed, so those two controls have to be
 * wired to the card that owns the dialog and the confirmation.
 *
 * The Source column earns its place because it is the only thing on the row that
 * decides whether the row can be touched at all. Rendering it as a badge — and
 * saying why in its tooltip — is cheaper than letting someone discover the rule
 * by clicking a control that refuses.
 *
 * Prices are per million tokens in both directions, because the asymmetry between
 * them is the number that decides whether a model is worth routing to.
 */

export interface ModelColumnsOptions {
  /** `opener` is the button that was clicked, so focus can return to it. */
  readonly onEdit: (model: ProviderModel, opener: HTMLElement | null) => void;
  readonly onDelete: (model: ProviderModel) => void;
}

/** A small icon-only row control, sized and toned like the accounts table's. */
const ROW_ACTION =
  'rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus';
const ROW_EDIT = `${ROW_ACTION} hover:text-text`;
const ROW_DELETE = `${ROW_ACTION} hover:text-danger`;

export function modelColumns({
  onEdit,
  onDelete,
}: ModelColumnsOptions): readonly DataTableColumn<ProviderModel>[] {
  return [
    {
      id: 'model',
      header: 'Model',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs text-text" title={row.displayName}>
              {row.displayName}
            </span>
            {row.deprecated ? (
              <Badge tone="warning" size="sm">
                Deprecated
              </Badge>
            ) : null}
          </span>
          <span className="truncate font-mono text-[0.6875rem] text-text-subtle">{row.id}</span>
        </span>
      ),
    },
    {
      id: 'source',
      header: 'Source',
      hideBelow: 'sm',
      cell: (row) => (
        <Tooltip content={MODEL_SOURCE_HINTS[row.source]}>
          <Badge tone={MODEL_SOURCE_TONES[row.source]} size="sm">
            {MODEL_SOURCE_LABELS[row.source]}
          </Badge>
        </Tooltip>
      ),
    },
    {
      id: 'context',
      header: 'Context',
      align: 'end',
      cell: (row) => (
        <span className="tabular-nums text-text-muted">
          {row.contextWindow === null ? '—' : formatTokens(row.contextWindow)}
        </span>
      ),
    },
    {
      id: 'output',
      header: 'Max out',
      align: 'end',
      hideBelow: 'sm',
      cell: (row) => (
        <span className="tabular-nums text-text-muted">
          {row.maxOutputTokens === null ? '—' : formatTokens(row.maxOutputTokens)}
        </span>
      ),
    },
    {
      id: 'capabilities',
      header: 'Capabilities',
      hideBelow: 'md',
      cell: (row) => <CapabilityChips capabilities={row.capabilities} />,
    },
    {
      id: 'inputPrice',
      header: 'In /M',
      align: 'end',
      hideBelow: 'md',
      cell: (row) => (
        <span className="tabular-nums text-text-muted">{formatPerMTok(row.inputPricePerMTok)}</span>
      ),
    },
    {
      id: 'outputPrice',
      header: 'Out /M',
      align: 'end',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="tabular-nums text-text-muted">
          {formatPerMTok(row.outputPricePerMTok)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'end',
      widthClassName: 'w-20',
      cell: (row) =>
        isEditableModel(row) ? (
          <span className="flex items-center justify-end gap-0.5">
            <button
              type="button"
              aria-label={`Edit ${row.displayName}`}
              onClick={(event) => {
                onEdit(row, event.currentTarget);
              }}
              className={ROW_EDIT}
            >
              <Pencil aria-hidden="true" className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Delete ${row.displayName}`}
              onClick={() => {
                onDelete(row);
              }}
              className={ROW_DELETE}
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
            </button>
          </span>
        ) : (
          // The provider's own entries have no controls on purpose, and a dash
          // says so without the noise of two disabled buttons per row.
          <span className="pr-2 text-text-subtle" aria-hidden="true">
            —
          </span>
        ),
    },
  ];
}
