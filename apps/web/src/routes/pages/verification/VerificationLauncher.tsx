import { ScanSearch } from 'lucide-react';
import { useState } from 'react';

import type { ProbeBudget } from '@contracts';
import { PROBE_BUDGET_COUNTS } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardFooter, CardHeader } from '@web/components/ui/Card.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { useProviderDetail, useProviders } from '@web/hooks/use-providers.ts';
import { useCreateVerification } from '@web/hooks/use-tools.ts';

/**
 * Probing an endpoint.
 *
 * Three things are needed and no more: which endpoint, which model, and the
 * family it claims to be. The claim is a hypothesis the probes test rather than a
 * fact the form accepts — which is why it is typed by hand instead of picked from
 * a list of real families. A picker would imply the answer is known in advance,
 * and the entire point of the page is that it is not.
 *
 * The endpoint selects sit outside a `Field` on purpose: the primitive's label
 * wires itself to a generated id, and the select trigger cannot adopt one, so a
 * visible label there would point at nothing. They carry their own `aria-label`
 * and a block heading instead.
 */

const PROVIDERS_QUERY = {
  q: '',
  category: null,
  status: null,
  tier: 'all',
  sort: 'name',
  direction: 'asc',
  limit: 100,
} as const;

export interface VerificationLauncherProps {
  readonly onCreated: (resultId: string) => void;
  readonly onCancel: () => void;
}

export function VerificationLauncher({ onCreated, onCancel }: VerificationLauncherProps) {
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [claimedFamily, setClaimedFamily] = useState('');
  const [budget, setBudget] = useState<ProbeBudget>('standard');
  const [touched, setTouched] = useState(false);

  const create = useCreateVerification();
  const providers = useProviders(PROVIDERS_QUERY);
  const detail = useProviderDetail(providerId === '' ? null : providerId);

  const providerList = (providers.data?.pages ?? []).flatMap((page) => page.items);
  const modelList = detail.data?.models ?? [];

  const chooseProvider = (next: string): void => {
    setProviderId(next);
    setModelId('');
  };

  const claim = claimedFamily.trim();
  const claimError = touched && claim === '' ? 'Say which family this endpoint claims.' : undefined;
  const endpointError = !touched
    ? undefined
    : providerId === ''
      ? 'Choose the provider to probe.'
      : modelId === ''
        ? 'Choose the model to probe.'
        : undefined;

  const submit = (): void => {
    setTouched(true);
    if (providerId === '' || modelId === '' || claim === '') return;

    create.mutate(
      { providerId, model: modelId, claimedFamily: claim, budget },
      {
        onSuccess: (result) => {
          onCreated(result.id);
        },
      },
    );
  };

  const providerOptions = providerList.map((provider) => ({
    value: provider.id,
    label: provider.name,
  }));

  const modelOptions = modelList.map((model) => ({
    value: model.id,
    label: model.displayName,
  }));

  const modelPlaceholder =
    providerId === ''
      ? 'Pick a provider first'
      : detail.isPending
        ? 'Loading models…'
        : modelOptions.length === 0
          ? 'No models listed'
          : 'Choose a model';

  return (
    <Card>
      <CardHeader
        title="New verification"
        description="Run the probe suite against an endpoint and see which model family its behaviour actually resembles. The probes are behavioural — the endpoint is never asked to identify itself, because that answer is not evidence."
      />

      <CardBody className="flex flex-col gap-5">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-text-muted">Endpoint</span>
            <span className="text-[0.6875rem] text-text-subtle">
              The provider and the model to probe.
            </span>
          </div>

          <div className="flex flex-col gap-2 @[560px]:flex-row">
            <SimpleSelect
              aria-label="Provider"
              value={providerId}
              onValueChange={chooseProvider}
              disabled={providers.isPending}
              placeholder={providers.isPending ? 'Loading providers…' : 'Choose a provider'}
              options={providerOptions}
              invalid={endpointError !== undefined}
              className="min-w-0 flex-1"
            />
            <SimpleSelect
              aria-label="Model"
              value={modelId}
              onValueChange={setModelId}
              disabled={providerId === '' || detail.isPending || modelOptions.length === 0}
              placeholder={modelPlaceholder}
              options={modelOptions}
              invalid={endpointError !== undefined}
              className="min-w-0 flex-1"
            />
          </div>

          {endpointError === undefined ? null : (
            <p role="alert" className="text-[0.6875rem] text-danger-text">
              {endpointError}
            </p>
          )}
        </div>

        <Field
          label="Claimed family"
          required
          error={claimError}
          description="The family the endpoint says it is — the hypothesis the probes test, not a fact the form accepts."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-label="Claimed family"
              autoComplete="off"
              spellCheck={false}
              invalid={claimError !== undefined}
              placeholder="gpt-4"
              value={claimedFamily}
              onChange={(event) => {
                setClaimedFamily(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="flex flex-col gap-1.5 border-t border-border pt-4">
          <span className="text-xs font-medium text-text-muted">Probe budget</span>
          <span className="text-[0.6875rem] text-text-subtle">
            {`About ${String(PROBE_BUDGET_COUNTS[budget])} requests, spent from your own account. The distribution probes need dozens of samples before a divergence means anything, so a quick run reports that it had too few rather than reporting a number.`}
          </span>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {BUDGET_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={budget === option.value ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={budget === option.value}
                onClick={() => {
                  setBudget(option.value);
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </CardBody>

      <CardFooter className="justify-between">
        {create.isError ? (
          <p role="alert" className="text-[0.6875rem] text-danger-text">
            The probes could not be started. Nothing was sent — try again.
          </p>
        ) : (
          <span className="text-[0.6875rem] text-text-subtle">
            The number of probes actually spent is reported with the result.
          </span>
        )}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={submit}>
            <ScanSearch aria-hidden="true" className="size-3.5" />
            Run probes
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/** The three budgets, in the order a reader wants them: cheapest first. */
const BUDGET_OPTIONS: readonly { readonly value: ProbeBudget; readonly label: string }[] = [
  { value: 'quick', label: 'Quick' },
  { value: 'standard', label: 'Standard' },
  { value: 'deep', label: 'Deep' },
];
