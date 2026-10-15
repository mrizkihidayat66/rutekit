import { useEffect, useState } from 'react';

import type { Combo, ComboInput, LoadBalanceStrategy } from '@contracts';

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
import { useCreateCombo, useUpdateCombo } from '@web/hooks/use-routing.ts';

import { EntryList } from './EntryList.tsx';
import {
  STRATEGY_HINTS,
  STRATEGY_LABELS,
  STRATEGY_OPTIONS,
  draftFromCombo,
  inputFromDraft,
  isSlug,
  newEntryDraft,
  type EntryDraft,
} from './combos.ts';

/**
 * Create or edit a combo.
 *
 * One form for both, because a combo is one statement: a name clients send, a
 * strategy, and the chain of models that name resolves to. Editing sends the
 * whole thing — the entries especially, since their order and weights are the
 * combo, and a partial update to a list is a question about what happens to the
 * rows the client did not mention. Sending the full list leaves no such question.
 *
 * The name is fixed once the combo exists. It is what clients already send in
 * their requests, and changing it would silently break every caller while
 * looking, in the console, like a rename. Renaming is a new combo and a
 * migration, not an edit.
 *
 * The entries are validated as a whole rather than per row: an empty model id or
 * a non-positive weight makes the row unsendable, and the dialog says so once,
 * at the bottom, next to the button that would send it.
 */

export interface ComboEditDialogProps {
  readonly combo: Combo | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providerOptions: readonly { readonly value: string; readonly label: string }[];
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

interface FormState {
  name: string;
  displayName: string;
  description: string;
  strategy: LoadBalanceStrategy;
  entries: EntryDraft[];
  fallbackOnError: boolean;
  enabled: boolean;
}

const EMPTY: FormState = {
  name: '',
  displayName: '',
  description: '',
  strategy: 'sequential',
  entries: [],
  fallbackOnError: true,
  enabled: true,
};

function fromCombo(combo: Combo): FormState {
  return {
    name: combo.name,
    displayName: combo.displayName,
    description: combo.description ?? '',
    strategy: combo.strategy,
    entries: draftFromCombo(combo),
    fallbackOnError: combo.fallbackOnError,
    enabled: combo.enabled,
  };
}

export function ComboEditDialog({
  combo,
  open,
  onOpenChange,
  providerOptions,
  restoreFocusTo,
}: ComboEditDialogProps) {
  const create = useCreateCombo();
  const update = useUpdateCombo();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    const next = combo === null ? EMPTY : fromCombo(combo);
    // A brand-new combo opens with one empty row rather than none: an empty list
    // is not a valid combo, and making the operator press "Add entry" first is
    // one keystroke of friction for a row they were always going to need.
    setForm(next.entries.length === 0 ? { ...next, entries: [newEntryDraft()] } : next);
    setTouched(false);
    create.reset();
    update.reset();
  }, [open, combo]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const nameError =
    touched && !isSlug(form.name.trim())
      ? 'Use lower-case letters, digits and dashes, like cheap-fleet.'
      : undefined;
  const displayNameError =
    touched && form.displayName.trim() === '' ? 'Give the combo a display name.' : undefined;

  const inputs = form.entries.map(inputFromDraft);
  const badRows = inputs
    .map((input, index) => (input === undefined ? index + 1 : null))
    .filter((index): index is number => index !== null);
  const entriesError =
    touched && form.entries.length === 0
      ? 'A combo needs at least one entry.'
      : touched && badRows.length > 0
        ? `Entry ${badRows.join(', ')} needs a model id and a weight above zero.`
        : undefined;

  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;

  const submit = () => {
    setTouched(true);
    if (!isSlug(form.name.trim()) || form.displayName.trim() === '') return;
    if (form.entries.length === 0) return;
    const entries = inputs.filter((input) => input !== undefined);
    if (entries.length !== form.entries.length) return;

    const input: ComboInput = {
      name: form.name.trim(),
      displayName: form.displayName.trim(),
      description: form.description.trim() === '' ? null : form.description.trim(),
      strategy: form.strategy,
      entries,
      fallbackOnError: form.fallbackOnError,
      enabled: form.enabled,
    };
    const close = () => {
      onOpenChange(false);
    };

    if (combo === null) {
      create.mutate(input, { onSuccess: close });
      return;
    }
    update.mutate({ id: combo.id, patch: input }, { onSuccess: close });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogHeader>
          <DialogTitle>{combo === null ? 'New combo' : 'Edit combo'}</DialogTitle>
          <DialogDescription>
            {combo === null
              ? 'A combo is one model name that clients send and rutekit answers with whichever entry in the chain is available.'
              : 'Change the chain, its order or its weights. Clients keep sending the same name.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
            <Field
              label="Name"
              required
              error={nameError}
              description={
                combo === null ? 'What clients send as the model.' : 'Fixed once the combo exists.'
              }
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.name}
                  disabled={combo !== null}
                  maxLength={64}
                  invalid={nameError !== undefined}
                  placeholder="cheap-fleet"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => {
                    set('name', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label="Display name" required error={displayNameError}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.displayName}
                  maxLength={64}
                  invalid={displayNameError !== undefined}
                  placeholder="Cheap fleet"
                  autoComplete="off"
                  onChange={(event) => {
                    set('displayName', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field label="Strategy" description={STRATEGY_HINTS[form.strategy]}>
            {() => (
              <SimpleSelect
                value={form.strategy}
                onValueChange={(next) => {
                  if (next === 'sequential' || next === 'round_robin') set('strategy', next);
                }}
                options={[...STRATEGY_OPTIONS]}
                aria-label="Load balancing strategy"
                className="w-full @[520px]:w-64"
              />
            )}
          </Field>

          <Field
            label="Chain"
            error={entriesError}
            description={`Tried in order when the strategy is ${STRATEGY_LABELS[form.strategy].toLowerCase()}.`}
          >
            {() => (
              <EntryList
                entries={form.entries}
                providerOptions={providerOptions}
                weighted={form.strategy === 'round_robin'}
                onChange={(entries) => {
                  set('entries', entries);
                }}
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
                placeholder="What this chain is for."
                onChange={(event) => {
                  set('description', event.target.value);
                }}
              />
            )}
          </Field>

          <fieldset className="flex flex-col gap-3 rounded-control border border-border p-3">
            <legend className="px-1 text-xs font-medium text-text-muted">Behaviour</legend>
            <label className="flex cursor-pointer items-start justify-between gap-4 text-xs text-text">
              <span className="flex min-w-0 flex-col">
                <span>Fall back on error</span>
                <span className="text-[0.6875rem] text-text-subtle">
                  Move to the next entry when one fails. Off means the first failure is returned.
                </span>
              </span>
              <Switch
                checked={form.fallbackOnError}
                aria-label="Fall back on error"
                onCheckedChange={(checked) => {
                  set('fallbackOnError', checked);
                }}
              />
            </label>
            <label className="flex cursor-pointer items-start justify-between gap-4 text-xs text-text">
              <span className="flex min-w-0 flex-col">
                <span>Enabled</span>
                <span className="text-[0.6875rem] text-text-subtle">
                  A disabled combo stays configured but refuses to route.
                </span>
              </span>
              <Switch
                checked={form.enabled}
                aria-label="Combo enabled"
                onCheckedChange={(checked) => {
                  set('enabled', checked);
                }}
              />
            </label>
          </fieldset>

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
            {combo === null ? 'Create combo' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
