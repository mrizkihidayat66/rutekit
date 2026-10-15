import { useEffect, useState } from 'react';

import type { SmsProvider, SmsProviderKind } from '@contracts';

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
import { useCreateSmsProvider, useUpdateSmsProvider } from '@web/hooks/use-automation.ts';

import {
  SMS_PROVIDER_KINDS,
  SMS_PROVIDER_KIND_HINTS,
  SMS_PROVIDER_KIND_LABELS,
} from './sms-providers.ts';

/**
 * Add a key, or edit the parts of one that can be edited.
 *
 * One dialog rather than two, because the fields are the same form in two states
 * and a second copy would drift from the first the moment either gained a field.
 * What differs is the key itself: it is write-only, the read model returns only a
 * masked hint, and the endpoint that edits a row cannot be told what the old
 * secret was — so on an existing key the field is not shown at all, and the
 * dialog says so rather than leaving the operator to wonder.
 *
 * The country/operator/product triple is the last one the key worked with, so a
 * registration job can default to it instead of asking for a triple that already
 * succeeded. They are free text here rather than pickers because the set of valid
 * values is the activation service's, and a hard-coded list would be a guess that
 * goes stale the moment the service changes its catalogue.
 */

interface FormState {
  kind: SmsProviderKind;
  label: string;
  apiKey: string;
  country: string;
  operator: string;
  product: string;
  note: string;
}

const EMPTY: FormState = {
  kind: '5sim',
  label: '',
  apiKey: '',
  country: '',
  operator: '',
  product: '',
  note: '',
};

function draftFrom(sms: SmsProvider): FormState {
  return {
    kind: sms.kind,
    label: sms.label,
    apiKey: '',
    country: sms.country ?? '',
    operator: sms.operator ?? '',
    product: sms.product ?? '',
    note: sms.note ?? '',
  };
}

/** A blank field as the endpoint wants it: the text, or null. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export interface SmsFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The key to edit, or null to add a new one. */
  readonly sms: SmsProvider | null;
  /** The control that opened the dialog, so focus can return to it on close. */
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function SmsFormDialog({ open, onOpenChange, sms, restoreFocusTo }: SmsFormDialogProps) {
  const create = useCreateSmsProvider();
  const update = useUpdateSmsProvider();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState(false);

  const editing = sms !== null;

  useEffect(() => {
    if (!open) return;
    setForm(sms === null ? EMPTY : draftFrom(sms));
    setTouched(false);
    create.reset();
    update.reset();
  }, [open, sms]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const labelError = touched && form.label.trim() === '' ? 'Give this key a name you will recognise.' : undefined;
  const keyError =
    touched && !editing && form.apiKey.trim() === ''
      ? 'Paste the key the service issued.'
      : undefined;

  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const close = () => {
    onOpenChange(false);
  };

  const submit = () => {
    setTouched(true);
    if (form.label.trim() === '') return;
    if (!editing && form.apiKey.trim() === '') return;

    if (sms === null) {
      create.mutate(
        {
          kind: form.kind,
          label: form.label.trim(),
          apiKey: form.apiKey.trim(),
          country: orNull(form.country),
          operator: orNull(form.operator),
          product: orNull(form.product),
          note: orNull(form.note),
        },
        { onSuccess: close },
      );
      return;
    }

    update.mutate(
      {
        id: sms.id,
        patch: {
          kind: form.kind,
          label: form.label.trim(),
          country: orNull(form.country),
          operator: orNull(form.operator),
          product: orNull(form.product),
          note: orNull(form.note),
        },
      },
      { onSuccess: close },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit SMS key' : 'Add an SMS key'}</DialogTitle>
          <DialogDescription>
            {editing
              ? `Change how ${sms.label} is used. Its key is write-only and cannot be read back, so it is left as it is.`
              : 'Add one activation key to the pool. It is stored write-only — this page can show a masked hint, never the key itself.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-3">
            <Field label="Service" description={SMS_PROVIDER_KIND_HINTS[form.kind]}>
              {() => (
                <SimpleSelect
                  aria-label="Service"
                  value={form.kind}
                  onValueChange={(next) => {
                    if (SMS_PROVIDER_KINDS.includes(next as SmsProviderKind)) {
                      set('kind', next as SmsProviderKind);
                    }
                  }}
                  options={SMS_PROVIDER_KINDS.map((value) => ({
                    value,
                    label: SMS_PROVIDER_KIND_LABELS[value],
                  }))}
                />
              )}
            </Field>

            <Field
              label="Name"
              required
              error={labelError}
              className="@[520px]:col-span-2"
              description="How this key is listed when a job picks one."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.label}
                  invalid={labelError !== undefined}
                  placeholder="5sim — main"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    set('label', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          {editing ? null : (
            <Field
              label="API key"
              required
              error={keyError}
              description="Stored write-only. The page will show a masked hint from here on."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.apiKey}
                  invalid={keyError !== undefined}
                  onChange={(event) => {
                    set('apiKey', event.target.value);
                  }}
                />
              )}
            </Field>
          )}

          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-3">
            <Field label="Country" description="Optional. The last one that worked.">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Any"
                  value={form.country}
                  onChange={(event) => {
                    set('country', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label="Operator" description="Optional. The last one that worked.">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Any"
                  value={form.operator}
                  onChange={(event) => {
                    set('operator', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label="Product" description="Optional. The last one that worked.">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Any"
                  value={form.product}
                  onChange={(event) => {
                    set('product', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field label="Note" description="Optional. Where it came from, how much is on it.">
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                autoGrow
                rows={2}
                value={form.note}
                placeholder="Topped up for the CN registrations."
                onChange={(event) => {
                  set('note', event.target.value);
                }}
              />
            )}
          </Field>

          {error === null ? null : (
            <p
              role="alert"
              className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
            >
              {error.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {editing ? 'Save changes' : 'Add key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
