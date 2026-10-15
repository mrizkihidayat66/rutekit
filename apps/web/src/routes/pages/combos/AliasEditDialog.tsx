import { useEffect, useState } from 'react';

import type { Alias, AliasInput } from '@contracts';

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
import { Switch } from '@web/components/ui/Switch.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { useCreateAlias, useUpdateAlias } from '@web/hooks/use-routing.ts';

import { isSlug } from './combos.ts';

/**
 * Create or edit an alias.
 *
 * An alias is the cheapest routing rule there is: one name, one destination. It
 * is the right tool when a client's model name is wrong and cannot be changed —
 * point the name they send at the model you actually want, and the client keeps
 * working without a code change on their side.
 *
 * The name is fixed once the alias exists, for the same reason a combo's is: it
 * is the string already on the wire. The target is not, because that is exactly
 * what an alias is for — moving a name from one model to another is the point.
 *
 * Pinning to a provider is optional and usually wrong: an alias that names only
 * a model lets the router pick the best provider for it, while one that pins a
 * provider is a way of saying "this name means this endpoint specifically".
 */

export interface AliasEditDialogProps {
  readonly alias: Alias | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providerOptions: readonly { readonly value: string; readonly label: string }[];
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

interface FormState {
  alias: string;
  target: string;
  providerId: string;
  description: string;
  enabled: boolean;
}

const EMPTY: FormState = {
  alias: '',
  target: '',
  providerId: '',
  description: '',
  enabled: true,
};

function fromAlias(alias: Alias): FormState {
  return {
    alias: alias.alias,
    target: alias.target,
    providerId: alias.providerId ?? '',
    description: alias.description ?? '',
    enabled: alias.enabled,
  };
}

export function AliasEditDialog({
  alias,
  open,
  onOpenChange,
  providerOptions,
  restoreFocusTo,
}: AliasEditDialogProps) {
  const create = useCreateAlias();
  const update = useUpdateAlias();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(alias === null ? EMPTY : fromAlias(alias));
    setTouched(false);
    create.reset();
    update.reset();
  }, [open, alias]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const aliasError =
    touched && !isSlug(form.alias.trim())
      ? 'Use lower-case letters, digits and dashes, like fast.'
      : undefined;
  const targetError =
    touched && form.target.trim() === '' ? 'Name the model this alias resolves to.' : undefined;

  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;

  const submit = () => {
    setTouched(true);
    if (!isSlug(form.alias.trim()) || form.target.trim() === '') return;

    const input: AliasInput = {
      alias: form.alias.trim(),
      target: form.target.trim(),
      providerId: form.providerId === '' ? null : form.providerId,
      description: form.description.trim() === '' ? null : form.description.trim(),
      enabled: form.enabled,
    };
    const close = () => {
      onOpenChange(false);
    };

    if (alias === null) {
      create.mutate(input, { onSuccess: close });
      return;
    }
    update.mutate({ id: alias.id, patch: input }, { onSuccess: close });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogHeader>
          <DialogTitle>{alias === null ? 'New alias' : 'Edit alias'}</DialogTitle>
          <DialogDescription>
            {alias === null
              ? 'Give a client the name it wants to send, and point it at the model you want it to reach.'
              : 'Change where this name resolves. The name itself stays put.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 @[440px]:grid-cols-2">
            <Field
              label="Alias"
              required
              error={aliasError}
              description={alias === null ? 'What clients send.' : 'Fixed once it exists.'}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.alias}
                  disabled={alias !== null}
                  maxLength={64}
                  invalid={aliasError !== undefined}
                  placeholder="fast"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => {
                    set('alias', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label="Target" required error={targetError} description="The real model id.">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.target}
                  maxLength={128}
                  invalid={targetError !== undefined}
                  placeholder="gpt-4o-mini"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => {
                    set('target', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field label="Provider" description="Optional. Leave it open to let the router choose.">
            {() => (
              <SimpleSelect
                value={form.providerId}
                onValueChange={(value) => {
                  set('providerId', value);
                }}
                placeholder="Any provider"
                options={[{ value: '', label: 'Any provider' }, ...providerOptions]}
                aria-label="Provider"
                className="w-full @[440px]:w-64"
              />
            )}
          </Field>

          <Field label="Description" description="Optional. Shown on the list.">
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                value={form.description}
                maxLength={280}
                rows={2}
                autoGrow
                placeholder="Why this alias exists."
                onChange={(event) => {
                  set('description', event.target.value);
                }}
              />
            )}
          </Field>

          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-control border border-border p-3 text-xs text-text">
            <span className="flex min-w-0 flex-col">
              <span>Enabled</span>
              <span className="text-[0.6875rem] text-text-subtle">
                A disabled alias is kept but not resolved.
              </span>
            </span>
            <Switch
              checked={form.enabled}
              aria-label="Alias enabled"
              onCheckedChange={(checked) => {
                set('enabled', checked);
              }}
            />
          </label>

          {failure === null || failure === undefined ? null : (
            <p
              role="alert"
              className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
            >
              {failure.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {alias === null ? 'Create alias' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
