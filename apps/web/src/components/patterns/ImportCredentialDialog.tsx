import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { Provider } from '@contracts';

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
import { useCreateAccount } from '@web/hooks/use-providers.ts';

import { CredentialFieldHint } from './CredentialNotice.tsx';
import { ProviderIcon } from './ProviderIcon.tsx';

/**
 * Add one credential to a provider's pool.
 *
 * The credential field is the whole point and is treated as such: it is masked,
 * it is never read back, and the hint next to it says so — an operator who has
 * just pasted a key and sees an empty field on the next visit must not think the
 * save failed. Everything else on the form is metadata that only matters once
 * the pool has more than one entry, which is why "Max in flight" is the one
 * number worth asking for: it is how a single credential is told to carry more
 * than one request at a time.
 *
 * The label is required rather than derived, because two credentials from the
 * same provider are indistinguishable once the email is masked.
 *
 * Two pages open this dialog and they know different things. Provider Detail
 * already knows which provider it is about, so the field is not there. The
 * Accounts page does not, so it passes the catalog and the operator picks — one
 * dialog either way, rather than a second form that would drift from this one.
 */

interface FormState {
  label: string;
  credential: string;
  email: string;
  note: string;
  maxInFlight: string;
}

const INITIAL: FormState = {
  label: '',
  credential: '',
  email: '',
  note: '',
  maxInFlight: '1',
};

export interface ImportCredentialDialogProps {
  /** The provider to import into, or null to let the operator choose one. */
  readonly provider: Provider | null;
  /** Offered when `provider` is null. Ignored otherwise. */
  readonly providers?: readonly Provider[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The control that opened the dialog, so focus can return to it on close. */
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function ImportCredentialDialog({
  provider,
  providers = [],
  open,
  onOpenChange,
  restoreFocusTo,
}: ImportCredentialDialogProps) {
  const create = useCreateAccount();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [chosen, setChosen] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(INITIAL);
      setChosen(provider?.id ?? '');
      setTouched(false);
      create.reset();
    }
  }, [open]);

  // The provider this submission is about: the one it was opened for, or the one
  // the operator picked. `null` while a choosing dialog is still unanswered.
  const target = provider ?? providers.find((row) => row.id === chosen) ?? null;

  const labelError = touched && form.label.trim() === '' ? 'Give this credential a label.' : undefined;
  const credentialError =
    touched && form.credential === '' ? 'Paste the credential to import.' : undefined;
  const inFlight = Number.parseInt(form.maxInFlight, 10);
  const inFlightError =
    touched && (!Number.isInteger(inFlight) || inFlight < 1)
      ? 'Enter a whole number of one or more.'
      : undefined;
  const providerError = touched && target === null ? 'Choose the provider to import into.' : undefined;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const submit = () => {
    setTouched(true);
    if (target === null) return;
    if (form.label.trim() === '') return;
    if (form.credential === '') return;
    if (!Number.isInteger(inFlight) || inFlight < 1) return;

    create.mutate({
      providerId: target.id,
      label: form.label.trim(),
      credential: form.credential,
      email: form.email.trim() === '' ? null : form.email.trim(),
      note: form.note.trim() === '' ? null : form.note.trim(),
      maxInFlight: inFlight,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        {create.isSuccess ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-pill border border-success/30 bg-success/12 text-success">
                  <Check aria-hidden="true" className="size-3.5" />
                </span>
                Credential imported
              </DialogTitle>
              <DialogDescription>
                The credential is stored write-only and starts out pending, so the router will not
                send it traffic until its first check-in succeeds.
              </DialogDescription>
            </DialogHeader>

            <p className="rounded-control border border-border bg-surface-2 p-2.5 text-xs text-text">
              {create.data.label}
              {create.data.emailMasked === null ? null : (
                <span className="ml-2 font-mono text-text-subtle">{create.data.emailMasked}</span>
              )}
            </p>

            <DialogFooter>
              <Button
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Import a credential</DialogTitle>
              <DialogDescription>
                {provider === null
                  ? 'Add one credential to a provider’s pool. It is stored write-only, so this page can show what it does but never what it is.'
                  : `Add one credential to ${provider.name}’s pool. It is stored write-only, so this page can show what it does but never what it is.`}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              {provider === null ? (
                <Field label="Provider" required error={providerError}>
                  {() => (
                    <SimpleSelect
                      value={chosen}
                      onValueChange={setChosen}
                      aria-label="Provider"
                      placeholder="Choose a provider…"
                      invalid={providerError !== undefined}
                      options={providers.map((row) => ({
                        value: row.id,
                        label: (
                          <span className="inline-flex items-center gap-2">
                            <ProviderIcon icon={row.icon} size="sm" />
                            {row.name}
                          </span>
                        ),
                      }))}
                    />
                  )}
                </Field>
              ) : null}

              <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
                <Field
                  label="Label"
                  required
                  error={labelError}
                  hint={`${form.label.length}/64`}
                  description="How this credential is named in the pool."
                >
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={form.label}
                      maxLength={64}
                      invalid={labelError !== undefined}
                      placeholder="alex@example.com"
                      autoComplete="off"
                      onChange={(event) => {
                        set('label', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field
                  label="Email"
                  description="Optional, shown masked. Helps tell two credentials apart."
                >
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      type="email"
                      inputMode="email"
                      value={form.email}
                      placeholder="alex@example.com"
                      autoComplete="off"
                      onChange={(event) => {
                        set('email', event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>

              <Field
                label="Credential"
                required
                error={credentialError}
                description={<CredentialFieldHint />}
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    type="password"
                    autoComplete="off"
                    value={form.credential}
                    invalid={credentialError !== undefined}
                    placeholder="sk-… or a session cookie"
                    onChange={(event) => {
                      set('credential', event.target.value);
                    }}
                  />
                )}
              </Field>

              <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
                <Field
                  label="Max in flight"
                  error={inFlightError}
                  description="How many requests one credential may serve at once."
                >
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

                <Field label="Note" description="Optional. Kept alongside the credential.">
                  {({ id, describedBy }) => (
                    <Textarea
                      id={id}
                      aria-describedby={describedBy}
                      autoGrow
                      rows={2}
                      value={form.note}
                      placeholder="Where it came from, when to rotate it."
                      onChange={(event) => {
                        set('note', event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>

              {create.isError ? (
                <p
                  role="alert"
                  className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
                >
                  {create.error.message}
                </p>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                variant="secondary"
                disabled={create.isPending}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button onClick={submit} loading={create.isPending}>
                {create.isPending ? 'Importing…' : 'Import credential'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
