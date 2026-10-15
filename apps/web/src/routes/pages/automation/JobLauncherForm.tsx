import { Play, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import type { BrowserEngine, JobInput, JobMethod, JobMode, Proxy, SmsProvider } from '@contracts';

import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import {
  ENGINE_HINTS,
  ENGINES,
  ENGINE_LABELS,
  JOB_METHOD_HINTS,
  JOB_METHOD_LABELS,
  JOB_MODE_HINTS,
  JOB_MODE_LABELS,
  JOB_MODES,
} from '@web/components/patterns/job-vocabulary.ts';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardFooter, CardHeader } from '@web/components/ui/Card.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCredits } from '@web/lib/format.ts';

import {
  AUTOMATION_PROVIDERS,
  automationMethods,
  automationProvider,
  methodHasField,
  type AutomationMethodSpec,
} from './automation-methods.ts';
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_CONCURRENCY,
  DEFAULT_ENGINE,
  DEFAULT_MODE,
  DEFAULT_QUANTITY,
  PROXY_PATH,
  SMS_PATH,
  countCredentials,
  optionalText,
  positiveInt,
} from './automation.ts';

/**
 * The launcher: what to import, and how hard to try.
 *
 * The page this sits on is called Automation because it is not one form — it is
 * however many forms the chosen provider needs. A provider's sign-in flow is a
 * fact about that provider: some can only sign existing credentials in, some can
 * also register accounts from nothing, and some take tokens that were minted
 * elsewhere and never open a browser at all. So the launcher picks a provider,
 * then a method, and only then draws the controls that method actually has —
 * asking for a browser engine on a token import would be offering a setting that
 * cannot affect the outcome.
 *
 * The matrix in `automation-methods.ts` is the source of both lists. The provider
 * picker is built from it rather than from the catalog's `automation` capability,
 * because the catalog answers "can this provider be automated at all" — a
 * question whose answer is yes for providers whose flow has no scriptable entry
 * point yet. This form needs the narrower fact: which methods, and therefore
 * which fields.
 *
 * Field order is the order the consequences get worse: the wrong provider imports
 * into the wrong place, and the wrong method posts credentials to an endpoint
 * that wanted tokens.
 */

export interface JobLauncherFormProps {
  /** The proxy pool, for the egress picker. */
  readonly proxies: readonly Proxy[];
  readonly proxiesLoading: boolean;
  /** The SMS pool, for a registration job's number rental. */
  readonly smsProviders: readonly SmsProvider[];
  readonly smsLoading: boolean;
  readonly submitting: boolean;
  readonly error: string | null;
  /** Bumped by the page when a job is accepted, to clear the pasted blob. */
  readonly resetKey: number;
  readonly onSubmit: (input: JobInput) => void;
}

/** The proxy pool, as the picker reads it. */
function proxyOptionLabel(proxy: Proxy): string {
  return `${proxy.host}:${String(proxy.port)} · ${proxy.protocol.toUpperCase()}`;
}

function smsOptionLabel(sms: SmsProvider): string {
  return sms.balance === null ? sms.label : `${sms.label} · ${formatCredits(sms.balance, sms.currency)}`;
}

export function JobLauncherForm({
  proxies,
  proxiesLoading,
  smsProviders,
  smsLoading,
  submitting,
  error,
  resetKey,
  onSubmit,
}: JobLauncherFormProps) {
  const [providerId, setProviderId] = useState('');
  const [method, setMethod] = useState<JobMethod | ''>('');
  const [engine, setEngine] = useState<BrowserEngine>(DEFAULT_ENGINE);
  const [mode, setMode] = useState<JobMode>(DEFAULT_MODE);
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [attempts, setAttempts] = useState(DEFAULT_ATTEMPTS);
  const [quantity, setQuantity] = useState(DEFAULT_QUANTITY);
  const [proxyId, setProxyId] = useState('');
  const [smsProviderId, setSmsProviderId] = useState('');
  const [country, setCountry] = useState('');
  const [operator, setOperator] = useState('');
  const [product, setProduct] = useState('');
  const [payload, setPayload] = useState('');
  const [touched, setTouched] = useState(false);

  // A started job is a batch that left the box; keeping the credentials on screen
  // after that is a secret sitting in the DOM for no reason.
  useEffect(() => {
    if (resetKey === 0) return;
    setPayload('');
    setTouched(false);
  }, [resetKey]);

  const spec: AutomationMethodSpec | undefined =
    providerId === '' || method === '' ? undefined : automationMethodFor(providerId, method);

  const providerOptions = AUTOMATION_PROVIDERS.map((entry) => ({
    value: entry.providerId,
    label: (
      <span className="inline-flex items-center gap-2">
        <ProviderIcon icon={entry.icon} size="sm" />
        {entry.name}
      </span>
    ),
  }));

  const methods = providerId === '' ? [] : automationMethods(providerId);

  /**
   * The method the segmented control should show as chosen.
   *
   * Choosing a provider sets one immediately, so this only differs from `method`
   * for the instant between a provider being picked and the effect landing —
   * but that instant is a render, and a control with no selected option renders
   * as if the operator had cleared it.
   */
  const activeMethod: JobMethod | undefined = method === '' ? methods[0]?.method : method;

  /**
   * Choosing a provider chooses its first method.
   *
   * A provider's own first entry is the one it exists for — the sign-in for the
   * three that have one, the registration for the one that does not — so
   * defaulting to it saves a click without ever picking something surprising.
   */
  const chooseProvider = (next: string) => {
    setProviderId(next);
    setMethod(automationMethods(next)[0]?.method ?? '');
    setPayload('');
    setTouched(false);
  };

  const chooseMethod = (next: JobMethod) => {
    setMethod(next);
    setTouched(false);
  };

  const credentialCount = countCredentials(payload);
  const parsedConcurrency = positiveInt(concurrency);
  const parsedAttempts = positiveInt(attempts);
  const parsedQuantity = positiveInt(quantity);

  const showsEngine = spec !== undefined && methodHasField(spec, 'engine');
  const showsPayload = spec !== undefined && spec.payload !== null;
  const showsProxy = spec !== undefined && methodHasField(spec, 'proxy');
  const showsSms = spec !== undefined && methodHasField(spec, 'sms');
  const showsQuantity = spec !== undefined && methodHasField(spec, 'quantity');

  const providerError = touched && providerId === '' ? 'Choose the provider to import into.' : undefined;
  const payloadError =
    touched && showsPayload && credentialCount === 0
      ? `Paste at least one ${spec?.payload?.label.toLowerCase() ?? 'line'}.`
      : undefined;
  const concurrencyError =
    touched && parsedConcurrency === null ? 'A whole number, 1 or more.' : undefined;
  const attemptsError = touched && parsedAttempts === null ? 'A whole number, 1 or more.' : undefined;
  const quantityError =
    touched && showsQuantity && parsedQuantity === null ? 'A whole number, 1 or more.' : undefined;
  const smsError =
    touched && showsSms && smsProviderId === ''
      ? 'Choose the key that rents the numbers.'
      : undefined;

  const submit = () => {
    setTouched(true);
    if (providerId === '' || spec === undefined) return;
    if (parsedConcurrency === null || parsedAttempts === null) return;
    if (showsPayload && credentialCount === 0) return;
    if (showsQuantity && parsedQuantity === null) return;
    if (showsSms && smsProviderId === '') return;

    onSubmit({
      providerId,
      method: spec.method,
      engine: showsEngine ? engine : null,
      mode: showsEngine ? mode : null,
      concurrency: parsedConcurrency,
      proxyId: showsProxy && proxyId !== '' ? proxyId : null,
      payload: showsPayload ? payload : '',
      maxAttempts: parsedAttempts,
      smsProviderId: showsSms && smsProviderId !== '' ? smsProviderId : null,
      quantity: showsQuantity ? parsedQuantity : null,
      country: showsSms ? optionalText(country) : null,
      operator: showsSms ? optionalText(operator) : null,
      product: showsSms ? optionalText(product) : null,
    });
  };

  const proxyOptions = [
    { value: '', label: 'Let the router choose' },
    ...proxies.map((proxy) => ({ value: proxy.id, label: proxyOptionLabel(proxy) })),
  ];

  const smsOptions = [
    { value: '', label: smsLoading ? 'Loading keys…' : 'Choose an SMS provider' },
    ...smsProviders.map((sms) => ({ value: sms.id, label: smsOptionLabel(sms) })),
  ];

  return (
    <Card>
      <CardHeader
        title="New run"
        description="Pick a provider and a method. rutekit opens a browser only when the method needs one, and pauses for a human whenever a challenge appears."
      />
      <CardBody className="flex flex-col gap-4">
        <Field
          label="Provider"
          required
          error={providerError}
          description="Only providers with a scripted flow are listed."
        >
          {() => (
            <SimpleSelect
              aria-label="Provider"
              value={providerId}
              onValueChange={chooseProvider}
              placeholder="Choose a provider"
              options={providerOptions}
            />
          )}
        </Field>

        {methods.length <= 1 || activeMethod === undefined ? null : (
          <Field label="Method" description={JOB_METHOD_HINTS[activeMethod]}>
            {() => (
              <SegmentedControl
                aria-label="Method"
                value={activeMethod}
                onValueChange={chooseMethod}
                options={methods.map((entry) => ({
                  value: entry.method,
                  label: JOB_METHOD_LABELS[entry.method],
                }))}
                className="w-full"
              />
            )}
          </Field>
        )}

        {spec === undefined ? null : (
          <p className="rounded-control border border-border bg-surface-2 p-2.5 text-[0.6875rem] text-text-muted">
            {JOB_METHOD_HINTS[spec.method]}
          </p>
        )}

        {showsQuantity ? (
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="How many accounts"
              required
              error={quantityError}
              hint={parsedQuantity === null ? undefined : 'accounts'}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-label="How many accounts"
                  inputMode="numeric"
                  autoComplete="off"
                  invalid={quantityError !== undefined}
                  value={quantity}
                  onChange={(event) => {
                    setQuantity(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              label="Attempts"
              error={attemptsError}
              hint={parsedAttempts === null ? undefined : 'per account'}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-label="Attempts per account"
                  inputMode="numeric"
                  autoComplete="off"
                  invalid={attemptsError !== undefined}
                  value={attempts}
                  onChange={(event) => {
                    setAttempts(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Concurrency"
              error={concurrencyError}
              hint={parsedConcurrency === null ? undefined : 'browsers'}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-label="Concurrency"
                  inputMode="numeric"
                  autoComplete="off"
                  invalid={concurrencyError !== undefined}
                  value={concurrency}
                  onChange={(event) => {
                    setConcurrency(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              label="Attempts"
              error={attemptsError}
              hint={parsedAttempts === null ? undefined : 'per credential'}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-label="Attempts per credential"
                  inputMode="numeric"
                  autoComplete="off"
                  invalid={attemptsError !== undefined}
                  value={attempts}
                  onChange={(event) => {
                    setAttempts(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        )}

        {showsSms ? (
          <div className="flex flex-col gap-4">
            <Field
              label="SMS provider"
              required
              error={smsError}
              description={
                smsProviders.length === 0 && !smsLoading
                  ? 'No key can rent numbers yet. Add one to the SMS pool first.'
                  : 'The key whose balance pays for each number.'
              }
            >
              {() => (
                <div className="flex items-center gap-2">
                  <SimpleSelect
                    aria-label="SMS provider"
                    value={smsProviderId}
                    onValueChange={setSmsProviderId}
                    disabled={smsLoading || smsProviders.length === 0}
                    placeholder={smsLoading ? 'Loading keys…' : 'Choose an SMS provider'}
                    options={smsOptions}
                    className="min-w-0 flex-1"
                  />
                  <Link
                    to={SMS_PATH}
                    className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')}
                  >
                    Manage
                  </Link>
                </div>
              )}
            </Field>

            <div className="grid grid-cols-1 gap-4 @[560px]:grid-cols-3">
              <Field label="Country" description="Optional.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-label="Country"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Any"
                    value={country}
                    onChange={(event) => {
                      setCountry(event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label="Operator" description="Optional.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-label="Operator"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Any"
                    value={operator}
                    onChange={(event) => {
                      setOperator(event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label="Product" description="Optional.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-label="Product"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Any"
                    value={product}
                    onChange={(event) => {
                      setProduct(event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </div>
        ) : null}

        {showsEngine ? (
          <div className="flex flex-col gap-4">
            <Field label="Browser engine" description={ENGINE_HINTS[engine]}>
              {() => (
                <SegmentedControl
                  aria-label="Browser engine"
                  value={engine}
                  onValueChange={setEngine}
                  options={ENGINES.map((value) => ({ value, label: ENGINE_LABELS[value] }))}
                  className="w-full"
                />
              )}
            </Field>

            <Field label="Mode" description={JOB_MODE_HINTS[mode]}>
              {() => (
                <SegmentedControl
                  aria-label="Mode"
                  value={mode}
                  onValueChange={setMode}
                  options={JOB_MODES.map((value) => ({ value, label: JOB_MODE_LABELS[value] }))}
                  className="w-full"
                />
              )}
            </Field>
          </div>
        ) : null}

        {showsProxy ? (
          <Field
            label="Proxy"
            description={
              proxies.length === 0 && !proxiesLoading
                ? 'The pool is empty, so the router will use the host’s own address.'
                : 'The egress each browser leaves through.'
            }
          >
            {() => (
              <div className="flex items-center gap-2">
                <SimpleSelect
                  aria-label="Proxy"
                  value={proxyId}
                  onValueChange={setProxyId}
                  disabled={proxiesLoading || proxies.length === 0}
                  placeholder={proxiesLoading ? 'Loading the pool…' : 'Let the router choose'}
                  options={proxyOptions}
                  className="min-w-0 flex-1"
                />
                <Link
                  to={PROXY_PATH}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')}
                >
                  Manage
                </Link>
              </div>
            )}
          </Field>
        ) : null}

        {showsPayload ? (
          <Field
            label={spec?.payload?.label ?? 'Payload'}
            required
            error={payloadError}
            description={
              credentialCount === 0
                ? spec?.payload?.hint
                : `${credentialCount} ${credentialCount === 1 ? 'line' : 'lines'} ready.`
            }
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-label={`${spec?.payload?.label ?? 'Payload'}, one per line`}
                spellCheck={false}
                autoComplete="off"
                invalid={payloadError !== undefined}
                className="min-h-32 font-mono text-xs"
                placeholder={spec?.payload?.placeholder ?? ''}
                value={payload}
                onChange={(event) => {
                  setPayload(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}

        <p className="inline-flex items-start gap-1.5 text-[0.6875rem] text-text-subtle">
          <ShieldCheck aria-hidden="true" className="mt-px size-3 shrink-0" />
          {showsPayload && spec?.payload?.label === 'Tokens'
            ? 'Tokens are sent once and stored write-only. They are never read back into this page.'
            : 'Credentials are sent once and stored write-only. They are never read back into this page.'}
        </p>
      </CardBody>
      <CardFooter className="justify-between">
        {error === null ? (
          <span className="text-[0.6875rem] text-text-subtle">
            A run keeps going if you close this tab.
          </span>
        ) : (
          <p role="alert" className="text-[0.6875rem] text-danger-text">
            {error}
          </p>
        )}
        <Button loading={submitting} onClick={submit}>
          <Play aria-hidden="true" className="size-3.5" />
          {spec?.method === 'bulk-regist' ? 'Start registration' : 'Start run'}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** The spec for a provider+method pair, resolved without importing the finder twice. */
function automationMethodFor(providerId: string, method: JobMethod): AutomationMethodSpec | undefined {
  return automationProvider(providerId)?.methods.find((entry) => entry.method === method);
}
