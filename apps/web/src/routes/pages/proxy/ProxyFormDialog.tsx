import { useEffect, useState } from 'react';

import type { Proxy, ProxyProtocol } from '@contracts';

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
import { useCreateProxy, useUpdateProxy } from '@web/hooks/use-automation.ts';

import { PROXY_PROTOCOLS, PROXY_PROTOCOL_LABELS, proxyAddress } from './proxies.ts';

/**
 * Add a proxy, or edit the parts of one that can be edited.
 *
 * One dialog rather than two, because the fields are the same form in two states
 * and a second copy would drift from the first the moment either gained a field.
 * What differs is the credentials: they are write-only, the read model never
 * returns them, and the endpoint that edits a proxy cannot be told what the old
 * ones were — so on an existing proxy the two fields are not shown at all, and
 * the dialog says so rather than leaving the operator to wonder.
 *
 * The port is the field most likely to be wrong, so it is validated here rather
 * than left to the endpoint: a port outside 1–65535 is a typo, and a sentence
 * under the field is a better answer than a rejected request.
 */

interface FormState {
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  note: string;
}

const EMPTY: FormState = {
  protocol: 'http',
  host: '',
  port: '8080',
  username: '',
  password: '',
  note: '',
};

function draftFrom(proxy: Proxy): FormState {
  return {
    protocol: proxy.protocol,
    host: proxy.host,
    port: String(proxy.port),
    username: '',
    password: '',
    note: proxy.note ?? '',
  };
}

export interface ProxyFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The proxy to edit, or null to add a new one. */
  readonly proxy: Proxy | null;
  /** The control that opened the dialog, so focus can return to it on close. */
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function ProxyFormDialog({ open, onOpenChange, proxy, restoreFocusTo }: ProxyFormDialogProps) {
  const create = useCreateProxy();
  const update = useUpdateProxy();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState(false);

  const editing = proxy !== null;

  useEffect(() => {
    if (!open) return;
    setForm(proxy === null ? EMPTY : draftFrom(proxy));
    setTouched(false);
    create.reset();
    update.reset();
  }, [open, proxy]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const hostError = touched && form.host.trim() === '' ? 'Enter the host or address.' : undefined;
  const port = Number.parseInt(form.port, 10);
  const portError =
    touched && (!Number.isInteger(port) || port < 1 || port > 65535)
      ? 'Enter a whole number between 1 and 65535.'
      : undefined;

  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const close = () => {
    onOpenChange(false);
  };

  const submit = () => {
    setTouched(true);
    if (form.host.trim() === '') return;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;

    const note = form.note.trim() === '' ? null : form.note.trim();

    if (proxy === null) {
      const username = form.username.trim();
      create.mutate(
        {
          protocol: form.protocol,
          host: form.host.trim(),
          port,
          username: username === '' ? null : username,
          password: username === '' ? null : form.password,
          note,
        },
        { onSuccess: close },
      );
      return;
    }

    update.mutate(
      { id: proxy.id, patch: { protocol: form.protocol, host: form.host.trim(), port, note } },
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
          <DialogTitle>{editing ? 'Edit proxy' : 'Add a proxy'}</DialogTitle>
          <DialogDescription>
            {editing
              ? `Change how ${proxyAddress(proxy)} is reached. Its credentials are write-only and cannot be read back, so they are left as they are.`
              : 'Add one proxy to the pool. Credentials are optional and stored write-only — this page can show that a proxy wants them, never what they are.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-3">
            <Field label="Protocol">
              {() => (
                <SimpleSelect
                  value={form.protocol}
                  onValueChange={(next) => {
                    if (next === 'http' || next === 'https' || next === 'socks5') set('protocol', next);
                  }}
                  aria-label="Protocol"
                  options={PROXY_PROTOCOLS.map((value) => ({
                    value,
                    label: PROXY_PROTOCOL_LABELS[value],
                  }))}
                />
              )}
            </Field>

            <Field
              label="Host"
              required
              error={hostError}
              className="@[520px]:col-span-2"
              description="An address, or a hostname the router can resolve."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.host}
                  invalid={hostError !== undefined}
                  placeholder="203.0.113.10"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    set('host', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field label="Port" required error={portError}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={form.port}
                invalid={portError !== undefined}
                onChange={(event) => {
                  set('port', event.target.value);
                }}
              />
            )}
          </Field>

          {editing ? null : (
            <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
              <Field label="Username" description="Optional. Leave both blank for an open proxy.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={form.username}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      set('username', event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label="Password" description="Stored write-only, never shown again.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    type="password"
                    autoComplete="off"
                    value={form.password}
                    disabled={form.username.trim() === ''}
                    onChange={(event) => {
                      set('password', event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          )}

          <Field label="Note" description="Optional. Where it came from, how long it is rented for.">
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                autoGrow
                rows={2}
                value={form.note}
                placeholder="Residential pool, EU exit."
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
            {editing ? 'Save changes' : 'Add proxy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
