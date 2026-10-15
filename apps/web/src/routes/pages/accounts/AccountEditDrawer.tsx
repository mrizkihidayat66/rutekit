import { useEffect, useState, type ReactNode } from 'react';

import type { Account, AccountState, AccountUpdate, Provider } from '@contracts';

import { CredentialFieldHint } from '@web/components/patterns/CredentialNotice.tsx';
import {
  ACCOUNT_STATES,
  ACCOUNT_STATE_HINTS,
  ACCOUNT_STATE_LABELS,
} from '@web/components/patterns/provider-vocabulary.ts';
import { Button } from '@web/components/ui/Button.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { Drawer } from '@web/components/ui/Drawer.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { useDeleteAccount, useUpdateAccount } from '@web/hooks/use-providers.ts';
import { formatDateTime } from '@web/lib/format.ts';

/**
 * Everything an operator can change about one credential.
 *
 * The page's bulk bar handles the common case — a batch of keys that all need the
 * same thing — so this drawer is for the single row that needs a different
 * answer: a label that has gone stale, a note about where the key came from, a
 * credential that has to be swapped without losing the row's history.
 *
 * State is edited by hand here, which is deliberate and is why the field carries
 * the state's own explanation. Setting a credential to `active` overrides the
 * router's judgement about it; an operator should be able to read what they are
 * overruling before they do.
 *
 * The credential field starts empty and empty means "leave it alone" — the stored
 * secret is never read back (SEC-1), so there is nothing to prefill it with.
 */

const STATE_OPTIONS = ACCOUNT_STATES.map((state) => ({
  value: state,
  label: ACCOUNT_STATE_LABELS[state],
}));

interface FormState {
  label: string;
  note: string;
  maxInFlight: string;
  state: AccountState;
  stateReason: string;
  credential: string;
}

function initialForm(account: Account): FormState {
  return {
    label: account.label,
    note: account.note ?? '',
    maxInFlight: String(account.maxInFlight),
    state: account.state,
    stateReason: account.stateReason ?? '',
    credential: '',
  };
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs text-text-muted">{children}</dd>
    </div>
  );
}

export interface AccountEditDrawerProps {
  readonly account: Account | null;
  readonly providers: readonly Provider[];
  readonly onClose: () => void;
}

export function AccountEditDrawer({ account, providers, onClose }: AccountEditDrawerProps) {
  const update = useUpdateAccount();
  const remove = useDeleteAccount();
  const [form, setForm] = useState<FormState | null>(null);
  const [touched, setTouched] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const accountId = account?.id ?? null;

  // Re-seed whenever a different row is opened. Keyed on the id rather than the
  // object so a background refetch cannot wipe edits that are in progress.
  useEffect(() => {
    setForm(account === null ? null : initialForm(account));
    setTouched(false);
    setConfirmingDelete(false);
    update.reset();
    remove.reset();
  }, [accountId]);

  const provider = account === null ? undefined : providers.find((row) => row.id === account.providerId);

  const labelError = touched && form !== null && form.label.trim() === '' ? 'A label is required.' : undefined;
  const inFlight = form === null ? 0 : Number.parseInt(form.maxInFlight, 10);
  const inFlightError =
    touched && (!Number.isInteger(inFlight) || inFlight < 1)
      ? 'Enter a whole number of one or more.'
      : undefined;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => (previous === null ? previous : { ...previous, [key]: value }));
  };

  const save = () => {
    if (account === null || form === null) return;
    setTouched(true);
    if (form.label.trim() === '') return;
    if (!Number.isInteger(inFlight) || inFlight < 1) return;

    const patch: AccountUpdate = {
      label: form.label.trim(),
      note: form.note.trim() === '' ? null : form.note.trim(),
      maxInFlight: inFlight,
      state: form.state,
      stateReason: form.stateReason.trim() === '' ? null : form.stateReason.trim(),
      ...(form.credential === '' ? {} : { credential: form.credential }),
    };

    update.mutate({ id: account.id, patch }, { onSuccess: onClose });
  };

  return (
    <Drawer
      open={account !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={account === null ? 'Account' : account.label}
      description={
        provider === undefined
          ? 'One credential in the pool.'
          : `${provider.name} · ${account?.emailMasked ?? 'no email on file'}`
      }
      width="md"
      footer={
        <>
          <Button
            variant="danger"
            disabled={update.isPending || remove.isPending}
            onClick={() => {
              setConfirmingDelete(true);
            }}
          >
            Delete
          </Button>
          <Button
            className="ml-auto"
            variant="secondary"
            disabled={update.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button loading={update.isPending} disabled={form === null} onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      {form === null || account === null ? null : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 @[420px]:grid-cols-2">
            <Field label="Label" required error={labelError} hint={`${form.label.length}/64`}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.label}
                  maxLength={64}
                  invalid={labelError !== undefined}
                  autoComplete="off"
                  onChange={(event) => {
                    set('label', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label="Max in flight" error={inFlightError} description="Requests this key may serve at once.">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={64}
                  invalid={inFlightError !== undefined}
                  value={form.maxInFlight}
                  onChange={(event) => {
                    set('maxInFlight', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field
            label="State"
            description={ACCOUNT_STATE_HINTS[form.state]}
            hint="Overrides the router's own judgement"
          >
            {() => (
              <SimpleSelect
                value={form.state}
                options={STATE_OPTIONS}
                aria-label="State"
                onValueChange={(next) => {
                  if (ACCOUNT_STATES.includes(next as AccountState)) set('state', next as AccountState);
                }}
              />
            )}
          </Field>

          <Field
            label="State reason"
            description="Optional. Shown beside the state in the pool table."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={form.stateReason}
                placeholder="Refused at first check-in."
                autoComplete="off"
                onChange={(event) => {
                  set('stateReason', event.target.value);
                }}
              />
            )}
          </Field>

          <Field
            label="Replace credential"
            description={<CredentialFieldHint />}
            hint="Leave empty to keep the current one"
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="password"
                autoComplete="off"
                value={form.credential}
                placeholder="sk-… or a session cookie"
                onChange={(event) => {
                  set('credential', event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Note" description="Where this key came from, when to rotate it.">
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                autoGrow
                rows={2}
                value={form.note}
                onChange={(event) => {
                  set('note', event.target.value);
                }}
              />
            )}
          </Field>

          <dl className="rounded-card border border-border bg-surface-2 px-3 py-2">
            <Fact label="Account id">
              <span className="font-mono">{account.id}</span>
            </Fact>
            <Fact label="Failures">{account.consecutiveFailures}</Fact>
            <Fact label="In flight">
              {account.inFlight}/{account.maxInFlight}
            </Fact>
            <Fact label="Last used">
              {account.lastUsedAt === null ? 'never' : formatDateTime(account.lastUsedAt)}
            </Fact>
            <Fact label="Created">{formatDateTime(account.createdAt)}</Fact>
          </dl>

          {update.isError ? (
            <p
              role="alert"
              className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
            >
              {update.error.message}
            </p>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Delete this account?"
        description="The credential and its history are removed for good. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (account === null) return;
          remove.mutate(account.id, { onSuccess: onClose });
        }}
      />
    </Drawer>
  );
}
