import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import type { ProviderCategory, WireFamily } from '@contracts';

import { CredentialFieldHint } from '@web/components/patterns/CredentialNotice.tsx';
import {
  PROVIDER_CATEGORIES,
  PROVIDER_CATEGORY_HINTS,
  PROVIDER_CATEGORY_LABELS,
  WIRE_FAMILY_OPTIONS,
  isProviderCategory,
  isWireFamily,
} from '@web/components/patterns/provider-vocabulary.ts';
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
import { useOnboardProvider } from '@web/hooks/use-providers.ts';

import { ByokResult } from './ByokResult.tsx';
import { IconPicker } from './IconPicker.tsx';

/**
 * Add a BYOK endpoint (FR-2.5).
 *
 * The wizard does not just save — it verifies. Saving alone would leave the
 * operator looking at a catalog card that says "needs auth", with no way to tell
 * whether the URL was wrong, the key was wrong, or the endpoint simply lists no
 * models. So the dialog runs the same three calls the detail page offers, in the
 * only order that works: create, discover the endpoint's models, probe it. The
 * probe reports how many models it found, and a brand-new provider has none
 * until the fetch has run.
 *
 * The dialog owns the form; the outcome is handed to `ByokResult`. Validation is
 * deliberately thin — a name and a well-formed URL — because the endpoint itself
 * is the real validator, and a form that refuses to submit is a worse way to
 * learn the base URL is wrong than a probe that says so.
 */

type Phase = 'form' | 'verifying' | 'done';

interface FormState {
  name: string;
  description: string;
  category: ProviderCategory;
  wireFamily: WireFamily;
  baseUrl: string;
  docsUrl: string;
  icon: string;
  apiKey: string;
}

const INITIAL: FormState = {
  name: '',
  description: '',
  category: 'byok',
  wireFamily: 'openai',
  baseUrl: '',
  docsUrl: '',
  icon: 'plug',
  apiKey: '',
};

const CATEGORY_OPTIONS = PROVIDER_CATEGORIES.map((category) => ({
  value: category,
  label: PROVIDER_CATEGORY_LABELS[category],
}));

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ByokDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The control that opened the dialog, so focus can return to it on close. */
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function ByokDialog({ open, onOpenChange, restoreFocusTo }: ByokDialogProps) {
  const navigate = useNavigate();
  const onboard = useOnboardProvider();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(INITIAL);
      setTouched(false);
      onboard.reset();
    }
  }, [open]);

  const phase: Phase = onboard.isSuccess ? 'done' : onboard.isPending ? 'verifying' : 'form';

  const nameError = touched && form.name.trim() === '' ? 'Give the provider a name.' : undefined;
  const baseUrlError =
    touched && form.baseUrl.trim() !== '' && !isHttpUrl(form.baseUrl.trim())
      ? 'Enter a full URL, including https://.'
      : undefined;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const submit = () => {
    setTouched(true);
    if (form.name.trim() === '') return;
    if (form.baseUrl.trim() !== '' && !isHttpUrl(form.baseUrl.trim())) return;
    onboard.mutate({
      name: form.name.trim(),
      description: form.description.trim(),
      category: form.category,
      wireFamily: form.wireFamily,
      baseUrl: form.baseUrl.trim() === '' ? null : form.baseUrl.trim(),
      docsUrl: form.docsUrl.trim() === '' ? null : form.docsUrl.trim(),
      icon: form.icon,
      apiKey: form.apiKey.trim() === '' ? null : form.apiKey,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        {onboard.isSuccess ? (
          <ByokResult
            result={onboard.data}
            onOpen={() => {
              const { id } = onboard.data.provider;
              onOpenChange(false);
              void navigate(`/providers/${id}`);
            }}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add a provider</DialogTitle>
              <DialogDescription>
                Point rutekit at an OpenAI-compatible endpoint you already have access to. The endpoint
                is probed before the dialog closes, so you find out now whether it answers.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
                <Field label="Name" required error={nameError} hint={`${String(form.name.length)}/64`}>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={form.name}
                      maxLength={64}
                      invalid={nameError !== undefined}
                      placeholder="My endpoint"
                      autoComplete="off"
                      onChange={(event) => {
                        set('name', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field label="Category" description={PROVIDER_CATEGORY_HINTS[form.category]}>
                  {() => (
                    <SimpleSelect
                      value={form.category}
                      onValueChange={(next) => {
                        if (isProviderCategory(next)) set('category', next);
                      }}
                      options={CATEGORY_OPTIONS}
                      aria-label="Category"
                    />
                  )}
                </Field>
              </div>

              <Field
                label="Description"
                hint={`${String(form.description.length)}/280`}
                description="Shown on the catalog card."
              >
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    autoGrow
                    rows={2}
                    maxLength={280}
                    value={form.description}
                    placeholder="What this endpoint is for."
                    onChange={(event) => {
                      set('description', event.target.value);
                    }}
                  />
                )}
              </Field>

              <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
                <Field label="Wire family" description="The request dialect the endpoint speaks.">
                  {() => (
                    <SimpleSelect
                      value={form.wireFamily}
                      onValueChange={(next) => {
                        if (isWireFamily(next)) set('wireFamily', next);
                      }}
                      options={[...WIRE_FAMILY_OPTIONS]}
                      aria-label="Wire family"
                    />
                  )}
                </Field>

                <Field label="API key" description={<CredentialFieldHint />}>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      type="password"
                      autoComplete="off"
                      value={form.apiKey}
                      placeholder="sk-…"
                      onChange={(event) => {
                        set('apiKey', event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
                <Field
                  label="Base URL"
                  error={baseUrlError}
                  description="Leave empty when the endpoint is fixed."
                >
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      type="url"
                      inputMode="url"
                      invalid={baseUrlError !== undefined}
                      value={form.baseUrl}
                      placeholder="https://api.example.com/v1"
                      autoComplete="off"
                      onChange={(event) => {
                        set('baseUrl', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field label="Docs URL" description="Optional; linked from the detail page.">
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      type="url"
                      inputMode="url"
                      value={form.docsUrl}
                      placeholder="https://docs.example.com"
                      autoComplete="off"
                      onChange={(event) => {
                        set('docsUrl', event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>

              <Field label="Icon" description="How this provider appears in the catalog grid.">
                {() => (
                  <IconPicker
                    value={form.icon}
                    onChange={(slug) => {
                      set('icon', slug);
                    }}
                  />
                )}
              </Field>

              {onboard.isError ? (
                <p
                  role="alert"
                  className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
                >
                  {onboard.error.message}
                </p>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                variant="secondary"
                disabled={phase === 'verifying'}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button onClick={submit} loading={phase === 'verifying'}>
                {phase === 'verifying' ? 'Verifying endpoint…' : 'Add and verify'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
