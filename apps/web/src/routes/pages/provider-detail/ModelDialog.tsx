import { useEffect, useState } from 'react';

import type { ProviderModel, ProviderModelInput } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Checkbox } from '@web/components/ui/Checkbox.tsx';
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
import { useCreateProviderModel, useUpdateProviderModel } from '@web/hooks/use-providers.ts';
import { formatTokens } from '@web/lib/format.ts';

/**
 * Add a model to a provider by hand, or edit one already added that way.
 *
 * Create and edit are one form because they are one statement: the dialog always
 * sends every field, so what it submits is a complete description of the model
 * rather than a diff against a row the server would have to still have. That is
 * also why `id` stays editable on an edit — it is the string the endpoint expects
 * on the wire, and a typo in it is the thing an operator most often needs to fix.
 *
 * Token counts are asked for in tokens and echoed back in the compact form the
 * rest of the console uses, because "131072" is unambiguous and "131K" is not. A
 * field that rounded for the operator's convenience would store a number nobody
 * typed, and an endpoint's real context window is rarely round.
 *
 * A model the provider itself told us about never reaches this form: those rows
 * carry no controls, and the boundary refuses the write even if one is forged.
 */

const CAPABILITIES = [
  { key: 'vision', label: 'Vision', hint: 'Reads images as well as text.' },
  { key: 'tools', label: 'Tools', hint: 'Can call functions the client declares.' },
  {
    key: 'reasoning',
    label: 'Reasoning',
    hint: 'Exposes its thinking, or takes a reasoning budget.',
  },
  { key: 'embedding', label: 'Embedding', hint: 'Returns vectors rather than completions.' },
] as const;

type CapabilityKey = (typeof CAPABILITIES)[number]['key'];

interface FormState {
  id: string;
  displayName: string;
  contextWindow: string;
  maxOutputTokens: string;
  inputPrice: string;
  outputPrice: string;
  capabilities: Record<CapabilityKey, boolean>;
}

const NO_CAPABILITIES: Record<CapabilityKey, boolean> = {
  vision: false,
  tools: false,
  reasoning: false,
  embedding: false,
};

const EMPTY: FormState = {
  id: '',
  displayName: '',
  contextWindow: '',
  maxOutputTokens: '',
  inputPrice: '',
  outputPrice: '',
  capabilities: NO_CAPABILITIES,
};

function fromModel(model: ProviderModel): FormState {
  return {
    id: model.id,
    displayName: model.displayName,
    contextWindow: model.contextWindow === null ? '' : String(model.contextWindow),
    maxOutputTokens: model.maxOutputTokens === null ? '' : String(model.maxOutputTokens),
    inputPrice: model.inputPricePerMTok === null ? '' : String(model.inputPricePerMTok),
    outputPrice: model.outputPricePerMTok === null ? '' : String(model.outputPricePerMTok),
    capabilities: { ...model.capabilities },
  };
}

/** An optional positive whole number. `undefined` means the text is not one. */
function optionalTokens(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** An optional non-negative price. `undefined` means the text is not one. */
function optionalPrice(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The human form of a token count the operator has typed, or nothing yet. */
function tokenHint(value: string): string | undefined {
  const parsed = optionalTokens(value);
  return parsed === null || parsed === undefined ? undefined : formatTokens(parsed);
}

export interface ModelDialogProps {
  readonly providerId: string;
  /** The model being edited, or null to add a new one. */
  readonly model: ProviderModel | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The control that opened the dialog, so focus can return to it on close. */
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function ModelDialog({
  providerId,
  model,
  open,
  onOpenChange,
  restoreFocusTo,
}: ModelDialogProps) {
  const create = useCreateProviderModel(providerId);
  const update = useUpdateProviderModel(providerId);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(model === null ? EMPTY : fromModel(model));
    setTouched(false);
    create.reset();
    update.reset();
  }, [open, model]);

  const context = optionalTokens(form.contextWindow);
  const maxOutput = optionalTokens(form.maxOutputTokens);
  const inPrice = optionalPrice(form.inputPrice);
  const outPrice = optionalPrice(form.outputPrice);

  const idError =
    touched && form.id.trim() === '' ? 'Give the model the id the endpoint uses.' : undefined;
  const nameError =
    touched && form.displayName.trim() === '' ? 'Give the model a display name.' : undefined;
  const contextError =
    touched && context === undefined
      ? 'Enter a whole number of tokens, or leave it empty.'
      : undefined;
  const maxOutputError =
    touched && maxOutput === undefined
      ? 'Enter a whole number of tokens, or leave it empty.'
      : undefined;
  const inPriceError =
    touched && inPrice === undefined
      ? 'Enter a price of zero or more, or leave it empty.'
      : undefined;
  const outPriceError =
    touched && outPrice === undefined
      ? 'Enter a price of zero or more, or leave it empty.'
      : undefined;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const setCapability = (key: CapabilityKey, value: boolean) => {
    setForm((previous) => ({
      ...previous,
      capabilities: { ...previous.capabilities, [key]: value },
    }));
  };

  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;

  const submit = () => {
    setTouched(true);
    if (form.id.trim() === '' || form.displayName.trim() === '') return;
    if (context === undefined || maxOutput === undefined) return;
    if (inPrice === undefined || outPrice === undefined) return;

    const input: ProviderModelInput = {
      id: form.id.trim(),
      displayName: form.displayName.trim(),
      contextWindow: context,
      maxOutputTokens: maxOutput,
      capabilities: form.capabilities,
      inputPricePerMTok: inPrice,
      outputPricePerMTok: outPrice,
    };
    const close = () => {
      onOpenChange(false);
    };

    if (model === null) {
      create.mutate(input, { onSuccess: close });
      return;
    }
    update.mutate({ modelId: model.id, input }, { onSuccess: close });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogHeader>
          <DialogTitle>{model === null ? 'Add a model' : 'Edit model'}</DialogTitle>
          <DialogDescription>
            {model === null
              ? 'Describe a model this endpoint serves but did not list. rutekit routes to it by the id below, so it has to match what the endpoint expects.'
              : 'Change how rutekit describes this model. The id is what goes on the wire, so renaming it changes which model the endpoint is asked for.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
            <Field
              label="Model id"
              required
              error={idError}
              description="Exactly as the endpoint spells it."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.id}
                  maxLength={128}
                  invalid={idError !== undefined}
                  placeholder="vendor/model-name"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => {
                    set('id', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label="Display name" required error={nameError}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.displayName}
                  maxLength={128}
                  invalid={nameError !== undefined}
                  placeholder="Vendor Model Name"
                  autoComplete="off"
                  onChange={(event) => {
                    set('displayName', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
            <Field
              label="Context window"
              error={contextError}
              hint={tokenHint(form.contextWindow)}
              description="Tokens the model can read at once. Optional."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  invalid={contextError !== undefined}
                  value={form.contextWindow}
                  placeholder="128000"
                  onChange={(event) => {
                    set('contextWindow', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              label="Max output"
              error={maxOutputError}
              hint={tokenHint(form.maxOutputTokens)}
              description="Tokens it may answer with. Optional."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  invalid={maxOutputError !== undefined}
                  value={form.maxOutputTokens}
                  placeholder="8000"
                  onChange={(event) => {
                    set('maxOutputTokens', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
            <Field
              label="Input price"
              error={inPriceError}
              description="USD per million tokens. Optional."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  invalid={inPriceError !== undefined}
                  value={form.inputPrice}
                  placeholder="1.50"
                  onChange={(event) => {
                    set('inputPrice', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              label="Output price"
              error={outPriceError}
              description="USD per million tokens. Optional."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  invalid={outPriceError !== undefined}
                  value={form.outputPrice}
                  placeholder="6.00"
                  onChange={(event) => {
                    set('outputPrice', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <fieldset className="flex flex-col gap-2 rounded-control border border-border p-3">
            <legend className="px-1 text-xs font-medium text-text-muted">Capabilities</legend>
            <div className="grid grid-cols-1 gap-2.5 @[440px]:grid-cols-2">
              {CAPABILITIES.map((capability) => (
                <label
                  key={capability.key}
                  className="flex cursor-pointer items-start gap-2 text-xs text-text"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={form.capabilities[capability.key]}
                    onChange={(event) => {
                      setCapability(capability.key, event.target.checked);
                    }}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span>{capability.label}</span>
                    <span className="text-[0.6875rem] text-text-subtle">{capability.hint}</span>
                  </span>
                </label>
              ))}
            </div>
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
            {model === null ? 'Add model' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
