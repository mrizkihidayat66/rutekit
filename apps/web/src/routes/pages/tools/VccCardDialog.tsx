import { useEffect, useState } from 'react';

import type { VccCard, VccCardStatus } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/Dialog.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { useUpdateVccCard } from '@web/hooks/use-tools.ts';

import {
  VCC_BRAND_LABELS,
  VCC_STATUSES,
  VCC_STATUS_HINTS,
  VCC_STATUS_LABELS,
  VCC_STATUS_TONES,
  expiryLabel,
} from './tools.ts';

/**
 * Move a card through its lifecycle, or say what it is for.
 *
 * The card itself is shown but not editable: the number is the generator's
 * output and the whole point of the pool is that a card is what it is. What an
 * operator actually changes is its *state* — releasing a reserved card back to
 * active when the sign-up holding it was abandoned, or marking a used one so it
 * is not handed out twice.
 *
 * `assignedTo` is free text rather than a picker, because the thing a card is
 * assigned to is a sign-up that may not exist in this system at all.
 */

interface FormState {
  status: VccCardStatus;
  assignedTo: string;
  note: string;
}

function draftFrom(card: VccCard): FormState {
  return {
    status: card.status,
    assignedTo: card.assignedTo ?? '',
    note: card.note ?? '',
  };
}

/** A blank field as the endpoint wants it: the text, or null. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export interface VccCardDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The card being edited. The dialog is closed whenever this is null. */
  readonly card: VccCard | null;
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function VccCardDialog({ open, onOpenChange, card, restoreFocusTo }: VccCardDialogProps) {
  const update = useUpdateVccCard();
  const [form, setForm] = useState<FormState>({ status: 'active', assignedTo: '', note: '' });

  useEffect(() => {
    if (!open || card === null) return;
    setForm(draftFrom(card));
    update.reset();
  }, [open, card]);

  const close = () => {
    onOpenChange(false);
  };

  const submit = () => {
    if (card === null) return;
    update.mutate(
      {
        id: card.id,
        patch: {
          status: form.status,
          assignedTo: orNull(form.assignedTo),
          note: orNull(form.note),
        },
      },
      { onSuccess: close },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" restoreFocusTo={restoreFocusTo}>
        <DialogHeader>
          <DialogTitle>Card state</DialogTitle>
          <DialogDescription>
            {card === null
              ? 'No card selected.'
              : `Where ${card.maskedNumber} sits in the pool, and what it is being used for.`}
          </DialogDescription>
        </DialogHeader>

        {card === null ? null : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 p-3">
              <span className="font-mono text-sm text-text">{card.maskedNumber}</span>
              <Badge tone="neutral" size="sm">
                {VCC_BRAND_LABELS[card.brand]}
              </Badge>
              <Badge tone={VCC_STATUS_TONES[card.status]} size="sm">
                {VCC_STATUS_LABELS[card.status]}
              </Badge>
              <span className="text-[0.6875rem] tabular-nums text-text-subtle">
                expires {expiryLabel(card)} · BIN {card.bin}
              </span>
            </div>

            <Field label="State" description={VCC_STATUS_HINTS[form.status]}>
              {() => (
                <SimpleSelect
                  aria-label="State"
                  value={form.status}
                  onValueChange={(next) => {
                    if (VCC_STATUSES.includes(next as VccCardStatus)) {
                      setForm((previous) => ({ ...previous, status: next as VccCardStatus }));
                    }
                  }}
                  options={VCC_STATUSES.map((value) => ({
                    value,
                    label: VCC_STATUS_LABELS[value],
                  }))}
                />
              )}
            </Field>

            <Field
              label="Assigned to"
              description="Optional. The sign-up this card was spent on."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="openai-signup"
                  value={form.assignedTo}
                  onChange={(event) => {
                    setForm((previous) => ({ ...previous, assignedTo: event.target.value }));
                  }}
                />
              )}
            </Field>

            <Field label="Note" description="Optional. Why it changed, or what went wrong.">
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  autoGrow
                  rows={2}
                  value={form.note}
                  placeholder="Released after the sign-up timed out."
                  onChange={(event) => {
                    setForm((previous) => ({ ...previous, note: event.target.value }));
                  }}
                />
              )}
            </Field>

            {update.isError ? (
              <p role="alert" className="text-xs text-danger-text">
                The change was not saved. The card is unchanged.
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" disabled={update.isPending} onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} loading={update.isPending} disabled={card === null}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
