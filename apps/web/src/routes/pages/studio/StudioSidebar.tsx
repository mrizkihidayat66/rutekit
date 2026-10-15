import { Dices } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import type { AssetKind, ProviderCategory } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Slider } from '@web/components/ui/Slider.tsx';
import { useModels, useProviders } from '@web/hooks/use-providers.ts';
import { cn } from '@web/lib/cn.ts';

import {
  ASPECT_OPTIONS,
  BATCH_RANGE,
  GUIDANCE_RANGE,
  KIND_LABELS,
  STEPS_RANGE,
  randomSeed,
  type StudioDraft,
} from './studio.ts';

/**
 * The parameters a render is asked for with.
 *
 * A sidebar rather than a dialog, because these are not settings to confirm —
 * they are the dials an operator turns between attempts, and a panel that stays
 * on screen is the only version of that which does not cost a click per try.
 *
 * Only the providers that return pixels are offered. The console has no
 * capability flag that says "this endpoint generates images" — a model's four
 * flags are vision, tools, reasoning and embedding, and none of them means this
 * — so the two categories that do are used instead: `media` (Replicate, fal,
 * Stability, ElevenLabs) and `local` (a ComfyUI instance on this machine). It is
 * a proxy for the truth, and it is stated rather than hidden.
 */

const PICKER_QUERY = { q: '', sort: null, direction: 'asc', limit: 200 } as const;

/** The two categories whose providers generate rather than complete. */
const GENERATION_CATEGORIES: readonly ProviderCategory[] = ['media', 'local'];

const KIND_OPTIONS: readonly { readonly value: AssetKind; readonly label: string }[] = [
  { value: 'image', label: KIND_LABELS.image },
  { value: 'video', label: KIND_LABELS.video },
];

const BATCH_OPTIONS = Array.from(
  { length: BATCH_RANGE.max - BATCH_RANGE.min + 1 },
  (_, index) => BATCH_RANGE.min + index,
).map((count) => ({ value: String(count), label: count === 1 ? '1 render' : `${count} renders` }));

/** A labelled control. The wrapper is the label, so the control needs no id. */
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-text-muted">{label}</span>
        {hint === undefined ? null : (
          <span className="text-[0.6875rem] text-text-subtle tabular-nums">{hint}</span>
        )}
      </span>
      {children}
    </label>
  );
}

function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <Field label={label} hint={format === undefined ? value : format(value)}>
      <Slider
        values={[value]}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onValueChange={(next) => {
          const first = next[0];
          if (first !== undefined) onChange(first);
        }}
      />
    </Field>
  );
}

export interface StudioSidebarProps {
  readonly draft: StudioDraft;
  readonly onChange: (patch: Partial<StudioDraft>) => void;
  readonly disabled?: boolean;
}

export function StudioSidebar({ draft, onChange, disabled = false }: StudioSidebarProps) {
  const providers = useProviders({ ...PICKER_QUERY, category: null, status: null, tier: 'all' });
  const models = useModels({
    ...PICKER_QUERY,
    providerId: draft.providerId,
    capability: null,
    source: null,
    minContext: null,
  });

  const [seedText, setSeedText] = useState(() => String(draft.seed));
  useEffect(() => {
    setSeedText(String(draft.seed));
  }, [draft.seed]);

  const generationProviders = (providers.data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter((provider) => GENERATION_CATEGORIES.includes(provider.category));

  const providerOptions = generationProviders.map((provider) => ({
    value: provider.id,
    label: provider.name,
  }));

  const modelItems = (models.data?.pages ?? []).flatMap((page) => page.items);
  const modelOptions = modelItems.map((model) => ({ value: model.id, label: model.displayName }));

  // A provider and a model are picked for the operator on arrival, so the
  // prompt box is the only thing left to fill in. Both effects key on a string
  // rather than on the arrays they are derived from, which change identity every
  // render and would re-run them for nothing.
  const firstProviderId = generationProviders[0]?.id;
  const firstModelId = modelItems[0]?.id;

  useEffect(() => {
    if (draft.providerId !== null || firstProviderId === undefined) return;
    onChange({ providerId: firstProviderId, model: null });
  }, [draft.providerId, firstProviderId, onChange]);

  useEffect(() => {
    if (draft.providerId === null || draft.model !== null || firstModelId === undefined) return;
    onChange({ model: firstModelId });
  }, [draft.providerId, draft.model, firstModelId, onChange]);

  const commitSeed = (text: string) => {
    setSeedText(text);
    const parsed = Number.parseInt(text, 10);
    if (Number.isFinite(parsed) && parsed > 0) onChange({ seed: parsed });
  };

  return (
    <Card className="flex min-h-0 flex-col gap-4 overflow-y-auto scrollbar-none">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-text">Generation</h2>
        <p className="text-xs text-text-muted">
          What to render with, and how. Everything here is a starting point — the prompt decides the
          rest.
        </p>
      </div>

      <Field label="Provider">
        <SimpleSelect
          size="sm"
          value={draft.providerId ?? ''}
          options={providerOptions}
          placeholder={providers.isPending ? 'Loading providers…' : 'Choose a provider'}
          aria-label="Provider"
          disabled={disabled}
          onValueChange={(value) => {
            onChange({ providerId: value, model: null });
          }}
        />
      </Field>

      <Field label="Model">
        <SimpleSelect
          size="sm"
          value={draft.model ?? ''}
          options={modelOptions}
          placeholder={
            draft.providerId === null
              ? 'Pick a provider first'
              : models.isPending
                ? 'Loading models…'
                : 'No models for this provider'
          }
          aria-label="Model"
          disabled={disabled || draft.providerId === null || modelOptions.length === 0}
          onValueChange={(value) => {
            onChange({ model: value });
          }}
        />
      </Field>

      <Field label="Output">
        <SegmentedControl
          value={draft.kind}
          options={KIND_OPTIONS}
          aria-label="Output kind"
          className={cn(disabled && 'pointer-events-none opacity-55')}
          onValueChange={(value) => {
            onChange({ kind: value });
          }}
        />
      </Field>

      <Field label="Aspect">
        <SegmentedControl
          value={draft.aspect}
          options={ASPECT_OPTIONS}
          aria-label="Aspect ratio"
          className={cn(disabled && 'pointer-events-none opacity-55')}
          onValueChange={(value) => {
            onChange({ aspect: value });
          }}
        />
      </Field>

      <ParamSlider
        label="Steps"
        value={draft.steps}
        min={STEPS_RANGE.min}
        max={STEPS_RANGE.max}
        step={STEPS_RANGE.step}
        onChange={(next) => {
          onChange({ steps: next });
        }}
      />

      <ParamSlider
        label="Guidance"
        value={draft.guidance}
        min={GUIDANCE_RANGE.min}
        max={GUIDANCE_RANGE.max}
        step={GUIDANCE_RANGE.step}
        format={(value) => value.toFixed(1)}
        onChange={(next) => {
          onChange({ guidance: next });
        }}
      />

      <Field label="Seed">
        <div className="flex items-center gap-1.5">
          <Input
            inputSize="sm"
            type="number"
            inputMode="numeric"
            min={1}
            value={seedText}
            aria-label="Seed"
            disabled={disabled}
            className="flex-1"
            onChange={(event) => {
              commitSeed(event.target.value);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            aria-label="Roll a new seed"
            disabled={disabled}
            onClick={() => {
              onChange({ seed: randomSeed() });
            }}
          >
            <Dices aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </Field>

      <Field label="Batch">
        <SimpleSelect
          size="sm"
          value={String(draft.count)}
          options={BATCH_OPTIONS}
          aria-label="Batch size"
          disabled={disabled}
          onValueChange={(value) => {
            onChange({ count: Number.parseInt(value, 10) });
          }}
        />
      </Field>
    </Card>
  );
}
