import { AlertTriangle, Check, Info, Play, Plus, X } from 'lucide-react';
import { useState } from 'react';

import type { BenchmarkTarget } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardFooter, CardHeader } from '@web/components/ui/Card.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { Tooltip } from '@web/components/ui/Tooltip.tsx';
import { useProviderDetail, useProviders } from '@web/hooks/use-providers.ts';
import { useCreateBenchmark } from '@web/hooks/use-tools.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

import { BenchmarkRubricEditor } from './BenchmarkRubricEditor.tsx';
import {
  MAX_VARIANTS,
  TEMPLATE_PRESETS,
  emptyRunDraft,
  planVariants,
  targetKey,
  targetLabel,
  templateVariables,
  toInput,
  type RunDraft,
  type TemplatePreset,
} from './benchmark.ts';

/**
 * Writing a run: one template, its variants, and the endpoints to send them to.
 *
 * The template is the whole point. A variant is not typed out one at a time —
 * it is a placeholder in the text multiplied by the values given for it, so the
 * editor reads the template for `{{names}}` and grows a value box for each one
 * as they appear. That is also why a blank box is not an error: it means "leave
 * this one alone", and the preview says so rather than the run quietly asking
 * something nobody wrote.
 *
 * The preview is the honest part. A template with three two-valued variables is
 * eight cells per endpoint, and the count is shown before the run is queued, not
 * discovered afterwards in a bill.
 *
 * The presets exist because a blank template is a bad first question: deciding how
 * to word a prompt is a different job from deciding which endpoints to compare, and
 * doing both at once usually means doing the second one badly. Picking a preset
 * writes the text and its values into the same fields a person would have typed
 * into, so nothing about the editor changes afterwards — it is a starting point,
 * not a mode.
 */

const PREVIEW = 8;

const PROVIDERS_QUERY = {
  q: '',
  category: null,
  status: null,
  tier: 'all',
  sort: 'name',
  direction: 'asc',
  limit: 100,
} as const;

export interface BenchmarkTemplateEditorProps {
  readonly onCreated: (runId: string) => void;
  readonly onCancel: () => void;
}

export function BenchmarkTemplateEditor({ onCreated, onCancel }: BenchmarkTemplateEditorProps) {
  const [draft, setDraft] = useState<RunDraft>(emptyRunDraft);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [touched, setTouched] = useState(false);

  const create = useCreateBenchmark();
  const providers = useProviders(PROVIDERS_QUERY);
  const detail = useProviderDetail(providerId === '' ? null : providerId);

  const variables = templateVariables(draft.template);
  const plan = planVariants(draft.template, draft.values);

  // Derived from the text rather than remembered: edit one character and the
  // preset stops being the thing on screen, which is what the highlight should say.
  const activePreset = TEMPLATE_PRESETS.find((preset) => preset.template === draft.template);

  const providerList = (providers.data?.pages ?? []).flatMap((page) => page.items);
  const modelList = detail.data?.models ?? [];

  const setName = (value: string): void => {
    setDraft((current) => ({ ...current, name: value }));
  };

  const setTemplate = (value: string): void => {
    setDraft((current) => ({ ...current, template: value }));
  };

  const applyPreset = (preset: TemplatePreset): void => {
    setDraft((current) => ({
      ...current,
      template: preset.template,
      values: preset.values,
      name: current.name.trim() === '' ? preset.name : current.name,
    }));
  };

  const setSystemPrompt = (value: string): void => {
    setDraft((current) => ({ ...current, systemPrompt: value }));
  };

  const setValue = (name: string, value: string): void => {
    setDraft((current) => ({ ...current, values: { ...current.values, [name]: value } }));
  };

  const chooseProvider = (next: string): void => {
    setProviderId(next);
    setModelId('');
  };

  const addTarget = (): void => {
    if (providerId === '') return;
    const target: BenchmarkTarget = { providerId, model: modelId };
    const key = targetKey(target);
    if (draft.targets.some((entry) => targetKey(entry) === key)) return;
    setDraft((current) => ({ ...current, targets: [...current.targets, target] }));
    setModelId('');
  };

  const removeTarget = (key: string): void => {
    setDraft((current) => ({
      ...current,
      targets: current.targets.filter((entry) => targetKey(entry) !== key),
    }));
  };

  const nameError = touched && draft.name.trim() === '' ? 'Give the run a name.' : undefined;
  const templateError =
    touched && plan.variants.length === 0 ? 'Write the template to send.' : undefined;
  const targetError =
    touched && draft.targets.length === 0 ? 'Add at least one endpoint to compare.' : undefined;

  const cellCount = plan.variants.length * draft.targets.length;

  const submit = (): void => {
    setTouched(true);
    if (draft.name.trim() === '' || plan.variants.length === 0 || draft.targets.length === 0)
      return;

    create.mutate(toInput(draft, plan.variants), {
      onSuccess: (run) => {
        onCreated(run.id);
      },
    });
  };

  const providerOptions = providerList.map((provider) => ({
    value: provider.id,
    label: provider.name,
  }));

  const modelOptions = modelList.map((model) => ({
    value: model.id,
    label: model.displayName,
  }));

  return (
    <Card>
      <CardHeader
        title="New run"
        description="One template, sent to every endpoint you add. Wrap a word in double braces to turn it into a variable, then give that variable values — each combination is a variant."
      />

      <CardBody className="@container flex flex-col gap-5">
        <Field
          label="Run name"
          required
          error={nameError}
          description="What this run is, so the history stays readable."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-label="Run name"
              autoComplete="off"
              spellCheck={false}
              invalid={nameError !== undefined}
              placeholder="Summarise the policy, four ways"
              value={draft.name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-text-muted">Start from a template</span>
          <ul className="flex flex-wrap gap-1.5">
            {TEMPLATE_PRESETS.map((preset) => {
              const active = activePreset?.id === preset.id;
              return (
                <li key={preset.id}>
                  <Tooltip content={preset.summary}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        applyPreset(preset);
                      }}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-pill border py-1 pr-2.5 pl-2 text-[0.6875rem] transition duration-(--dur-micro) ease-out outline-none focus-visible:ring-2 focus-visible:ring-focus',
                        active
                          ? 'border-accent bg-surface-3 text-text'
                          : 'border-border bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text',
                      )}
                    >
                      {active ? <Check aria-hidden="true" className="size-3" /> : null}
                      {preset.name}
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
          <p className="text-[0.6875rem] text-text-subtle">
            Picking one fills the template and its values. Both stay yours to edit, and a run can be
            written from scratch instead.
          </p>
        </div>

        <Field
          label="Template"
          required
          error={templateError}
          description="The prompt every variant starts from. Placeholders look like {{document}}."
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-label="Template"
              spellCheck={false}
              autoComplete="off"
              autoGrow
              invalid={templateError !== undefined}
              className="min-h-32 font-mono text-xs"
              placeholder={'Summarise the following {{document}} in at most {{words}} words.'}
              value={draft.template}
              onChange={(event) => {
                setTemplate(event.target.value);
              }}
            />
          )}
        </Field>

        {variables.length === 0 ? (
          <p className="rounded-control border border-border bg-surface-2 p-2.5 text-[0.6875rem] text-text-muted">
            {'No placeholders yet. Wrap a word in double braces — {{document}} — and a value box ' +
              'appears here, one for each name the template uses.'}
          </p>
        ) : (
          <div className="grid gap-4 @[560px]:grid-cols-2">
            {variables.map((name) => (
              <Field
                key={name}
                label={<span className="font-mono">{`{{${name}}}`}</span>}
                description="Comma-separated. Each value becomes a variant; leave it blank to keep the placeholder."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-label={`Values for ${name}`}
                    autoComplete="off"
                    spellCheck={false}
                    inputSize="sm"
                    placeholder="one, two, three"
                    value={draft.values[name] ?? ''}
                    onChange={(event) => {
                      setValue(name, event.target.value);
                    }}
                  />
                )}
              </Field>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-medium text-text-muted">Variants</span>
            <span className="text-[0.6875rem] tabular-nums text-text-subtle">
              {formatCount(plan.variants.length)} to send
            </span>
          </div>

          {plan.variants.length === 0 ? (
            <p className="text-xs text-text-muted">
              Nothing to preview yet. The variants appear here as the template and its values come
              together.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {plan.variants.slice(0, PREVIEW).map((variant, index) => (
                <li key={index}>
                  <Badge tone="neutral" size="sm" title={variant.prompt}>
                    {variant.label}
                  </Badge>
                </li>
              ))}
              {plan.variants.length > PREVIEW ? (
                <li className="self-center text-[0.6875rem] text-text-subtle">
                  and {formatCount(plan.variants.length - PREVIEW)} more
                </li>
              ) : null}
            </ul>
          )}

          {plan.capped ? (
            <p className="inline-flex items-start gap-1.5 text-[0.6875rem] text-warning-text">
              <AlertTriangle aria-hidden="true" className="mt-px size-3 shrink-0" />
              {`These values expand to ${formatCount(plan.total)} combinations; only the first ` +
                `${formatCount(MAX_VARIANTS)} are sent. Narrow the values to cover them all.`}
            </p>
          ) : null}

          {plan.skipped.length > 0 ? (
            <p className="inline-flex items-start gap-1.5 text-[0.6875rem] text-text-subtle">
              <Info aria-hidden="true" className="mt-px size-3 shrink-0" />
              {`Left blank, so kept as placeholders rather than replaced: ${plan.skipped.join(', ')}.`}
            </p>
          ) : null}
        </div>

        <Field
          label="System prompt"
          description="Optional. Sent ahead of every variant, unchanged."
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-label="System prompt"
              spellCheck={false}
              autoComplete="off"
              autoGrow
              className="min-h-20"
              placeholder="Answer in plain language. No preamble."
              value={draft.systemPrompt}
              onChange={(event) => {
                setSystemPrompt(event.target.value);
              }}
            />
          )}
        </Field>

        <BenchmarkRubricEditor
          rubric={draft.rubric}
          onChange={(rubric) => {
            setDraft((current) => ({ ...current, rubric }));
          }}
        />

        <div className="flex flex-col gap-2.5 border-t border-border pt-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-text-muted">Endpoints</span>
            <span className="text-[0.6875rem] text-text-subtle">
              Every variant is sent to each one. Add at least one.
            </span>
          </div>

          <div className="flex flex-col gap-2 @[560px]:flex-row @[560px]:items-center">
            <SimpleSelect
              aria-label="Provider"
              value={providerId}
              onValueChange={chooseProvider}
              disabled={providers.isPending}
              placeholder={providers.isPending ? 'Loading providers…' : 'Choose a provider'}
              options={providerOptions}
              className="min-w-0 flex-1"
            />
            <SimpleSelect
              aria-label="Model"
              value={modelId}
              onValueChange={setModelId}
              disabled={providerId === '' || detail.isPending}
              placeholder={
                providerId === ''
                  ? 'Pick a provider first'
                  : detail.isPending
                    ? 'Loading models…'
                    : 'Provider default'
              }
              options={modelOptions}
              className="min-w-0 flex-1"
            />
            <Button
              variant="secondary"
              onClick={addTarget}
              disabled={providerId === ''}
              className="shrink-0"
            >
              <Plus aria-hidden="true" className="size-3.5" />
              Add
            </Button>
          </div>

          {targetError === undefined ? null : (
            <p role="alert" className="text-[0.6875rem] text-danger-text">
              {targetError}
            </p>
          )}

          {draft.targets.length === 0 ? (
            <p className="text-[0.6875rem] text-text-subtle">
              No endpoints yet. Pick a provider, choose a model, and add it.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {draft.targets.map((target) => {
                const key = targetKey(target);
                const label = targetLabel(target);
                return (
                  <li key={key}>
                    <span className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface-2 py-0.5 pr-1 pl-2 text-[0.6875rem] text-text">
                      <span className="font-mono">{label}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${label}`}
                        onClick={() => {
                          removeTarget(key);
                        }}
                        className="rounded-pill p-0.5 text-text-subtle transition-colors duration-(--dur-micro) outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <X aria-hidden="true" className="size-3" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardBody>

      <CardFooter className="justify-between">
        {create.isError ? (
          <p role="alert" className="text-[0.6875rem] text-danger-text">
            The run could not be queued. Nothing was sent — try again.
          </p>
        ) : (
          <span className="text-[0.6875rem] tabular-nums text-text-subtle">
            {formatCount(plan.variants.length)} variants × {formatCount(draft.targets.length)}{' '}
            endpoints = {formatCount(cellCount)} cells
          </span>
        )}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={submit}>
            <Play aria-hidden="true" className="size-3.5" />
            Start run
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
