import { Plus } from 'lucide-react';
import { useState } from 'react';

import type { ProviderModel } from '@contracts';

import { DataTable } from '@web/components/patterns/DataTable.tsx';
import { isEditableModel } from '@web/components/patterns/model-vocabulary.ts';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useDeleteProviderModel } from '@web/hooks/use-providers.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

import { ModelDialog } from './ModelDialog.tsx';
import { sortModels } from './detail.ts';
import { modelColumns } from './model-columns.tsx';

/**
 * What this provider can answer, and the little an operator may change about it.
 *
 * Two kinds of row share the table and only one of them is rutekit's to touch. A
 * model the provider advertised — from the curated catalog, or from the last time
 * the endpoint was asked — is the provider's own claim: the next fetch would
 * overwrite anything written over it, so those rows carry no controls and the
 * boundary refuses the write even if one is forged. A model an operator added by
 * hand is theirs to edit and remove, and those are the only rows that show the
 * two controls.
 *
 * "Fetch models" stays in the page header next to "Test" rather than here, because
 * the two are the same kind of gesture — ask the endpoint a question — and neither
 * is a write to a row.
 */

export interface ModelsCardProps {
  readonly providerId: string;
  readonly models: readonly ProviderModel[];
  readonly className?: string;
}

export function ModelsCard({ providerId, models, className }: ModelsCardProps) {
  const rows = sortModels(models);
  const custom = rows.filter(isEditableModel).length;
  const deprecated = rows.filter((model) => model.deprecated).length;

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProviderModel | null>(null);
  /** The control that opened the dialog, so focus can go back to it on close. */
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState<ProviderModel | null>(null);

  const remove = useDeleteProviderModel(providerId);

  const columns = modelColumns({
    onEdit: (model, control) => {
      setOpener(control);
      setEditing(model);
    },
    onDelete: (model) => {
      remove.reset();
      setConfirming(model);
    },
  });

  const dialogOpen = adding || editing !== null;

  return (
    <Card flush className={cn('flex flex-col', className)}>
      <div className="px-4 pt-4 pb-3">
        <CardHeader
          title="Models"
          description="What this endpoint can answer. Catalog and synced entries belong to the provider and are read-only; anything added by hand can be edited here."
          actions={
            <Button
              size="sm"
              onClick={(event) => {
                setOpener(event.currentTarget);
                setAdding(true);
              }}
            >
              <Plus aria-hidden="true" className="size-3.5" />
              Add model
            </Button>
          }
        />
      </div>

      {remove.error === null ? null : (
        <p
          role="alert"
          className="mx-4 mb-2 rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
        >
          {remove.error.message}
        </p>
      )}

      <div className="px-1 pb-2">
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Models this provider can answer"
          emptyState={
            <StateView
              kind="empty"
              title="No models yet"
              description="Nothing has been discovered for this endpoint. Fetch the model list, or add a model by hand."
            />
          }
          footer={
            rows.length === 0 ? null : (
              <span className="tabular-nums">
                {formatCount(rows.length)} {rows.length === 1 ? 'model' : 'models'}
                {custom === 0 ? '' : ` · ${formatCount(custom)} added by hand`}
                {deprecated === 0 ? '' : ` · ${formatCount(deprecated)} deprecated`}
              </span>
            )
          }
        />
      </div>

      <ModelDialog
        providerId={providerId}
        model={editing}
        open={dialogOpen}
        onOpenChange={(open) => {
          if (open) return;
          setAdding(false);
          setEditing(null);
        }}
        restoreFocusTo={opener}
      />

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title="Delete model?"
        description={
          confirming === null
            ? undefined
            : `"${confirming.displayName}" will be removed from this provider. rutekit will stop routing to "${confirming.id}".`
        }
        destructive
        confirmLabel="Delete model"
        onConfirm={() => {
          if (confirming === null) return;
          remove.mutate(confirming.id);
          setConfirming(null);
        }}
      />
    </Card>
  );
}
