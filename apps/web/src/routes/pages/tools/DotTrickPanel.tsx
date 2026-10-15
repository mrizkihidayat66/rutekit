import { Download, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardFooter, CardHeader } from '@web/components/ui/Card.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { CopyButton } from '@web/components/patterns/CopyButton.tsx';
import { useDotTrick } from '@web/hooks/use-tools.ts';
import { downloadText } from '@web/lib/download.ts';
import { formatCount } from '@web/lib/format.ts';

import {
  DEFAULT_DOT_MODE,
  DEFAULT_VARIANT_LIMIT,
  DOT_MODES,
  DOT_MODE_HINTS,
  DOT_MODE_LABELS,
  MAX_VARIANTS,
  variantsCsv,
  variantsText,
  type DotTrickMode,
} from './tools.ts';

/**
 * Dot trick: one address in, its variants out.
 *
 * Nothing here is stored, because there is nothing to store — the expansion is
 * arithmetic on a string and the answer is useful the moment it appears and not
 * afterwards. That is why the panel holds its result in the mutation rather than
 * in a list: closing the page is the only way to lose it, and that is fine.
 *
 * The address is validated before it is sent rather than after it fails, because
 * the endpoint's answer to a malformed address is a rejection with nothing to act
 * on, and the operator already knows what an address looks like.
 */

const DOT_MODES_OPTIONS = DOT_MODES.map((value) => ({
  value,
  label: DOT_MODE_LABELS[value],
}));

/** Enough of a check to catch a typo, without pretending to be a validator. */
function looksLikeAddress(value: string): boolean {
  const at = value.indexOf('@');
  return at > 0 && at < value.length - 1 && value.indexOf('@', at + 1) === -1;
}

export function DotTrickPanel() {
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<DotTrickMode>(DEFAULT_DOT_MODE);
  const [limit, setLimit] = useState(DEFAULT_VARIANT_LIMIT);
  const [touched, setTouched] = useState(false);

  const trick = useDotTrick();

  const parsedLimit = Number(limit);
  const limitValid =
    Number.isInteger(parsedLimit) && parsedLimit >= 0 && parsedLimit <= MAX_VARIANTS;

  const emailError =
    touched && !looksLikeAddress(email.trim())
      ? 'Enter one address, for example you@gmail.com.'
      : undefined;
  const limitError =
    touched && !limitValid
      ? `A whole number between 0 and ${formatCount(MAX_VARIANTS)}.`
      : undefined;

  const submit = (): void => {
    setTouched(true);
    if (!looksLikeAddress(email.trim()) || !limitValid) return;
    trick.mutate({ email: email.trim(), mode, limit: parsedLimit });
  };

  const result = trick.data;

  return (
    <Card>
      <CardHeader
        title="Dot trick"
        description="Expand one address into the spellings a provider is likely to treat as separate. Dots are ignored by most mail hosts, plus tags by fewer — generating both is the usual answer."
      />

      <CardBody className="flex flex-col gap-5">
        <Field
          label="Address"
          required
          error={emailError}
          description="The mailbox the variants all point at."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="email"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              invalid={emailError !== undefined}
              placeholder="you@gmail.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="flex flex-col gap-3 @[560px]:flex-row @[560px]:items-start">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-muted">Method</span>
            <SegmentedControl
              aria-label="Variant method"
              value={mode}
              onValueChange={setMode}
              options={DOT_MODES_OPTIONS}
            />
            <span className="max-w-sm text-[0.6875rem] text-text-subtle">
              {DOT_MODE_HINTS[mode]}
            </span>
          </div>

          <div className="flex w-full flex-col gap-1.5 @[560px]:w-52">
            <Field
              label="Limit"
              required
              error={limitError}
              description={`How many to generate in total. 0 takes every variant this method can spell, up to ${formatCount(MAX_VARIANTS)}.`}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="number"
                  inputMode="numeric"
                  inputSize="sm"
                  min={0}
                  max={MAX_VARIANTS}
                  invalid={limitError !== undefined}
                  value={limit}
                  onChange={(event) => {
                    setLimit(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        </div>
      </CardBody>

      <CardFooter className="justify-between">
        {trick.isError ? (
          <p role="alert" className="text-[0.6875rem] text-danger-text">
            The address could not be expanded. Check it and try again.
          </p>
        ) : (
          <span className="text-[0.6875rem] text-text-subtle">
            Variants that the provider rejects are not filtered out here — this only generates them.
          </span>
        )}
        <Button loading={trick.isPending} onClick={submit}>
          <Sparkles aria-hidden="true" className="size-3.5" />
          Generate
        </Button>
      </CardFooter>

      {result === undefined ? null : (
        <div className="flex flex-col gap-3 border-t border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-text">
                  <span className="font-mono">{result.localPart}</span>
                  <span className="text-text-muted">@</span>
                  <span className="font-mono">{result.domain}</span>
                </h3>
                <Badge tone="neutral" size="sm">
                  {formatCount(result.variants.length)} variant
                  {result.variants.length === 1 ? '' : 's'}
                </Badge>
                {result.truncated ? (
                  <Badge tone="warning" size="sm">
                    Capped
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-text-muted">
                {result.truncated
                  ? 'The limit cut the list short — there are more spellings than this.'
                  : 'Every spelling this method produces.'}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  downloadText(`${result.localPart}-variants.csv`, 'text/csv', variantsCsv(result));
                }}
              >
                <Download aria-hidden="true" className="size-3.5" />
                Export CSV
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface-2 px-3 py-2">
            <span className="text-[0.6875rem] text-text-subtle">
              All {formatCount(result.variants.length)} at once, one per line.
            </span>
            <CopyButton value={variantsText(result)} label="every variant" />
          </div>

          <ul className="scrollbar-none max-h-80 overflow-y-auto rounded-card border border-border">
            {result.variants.map((variant) => (
              <li
                key={variant.address}
                className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-1.5 last:border-0"
              >
                <span className="truncate font-mono text-xs text-text" title={variant.address}>
                  {variant.address}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone={variant.technique === 'dot' ? 'info' : 'accent'} size="sm">
                    {variant.technique === 'dot' ? 'dot' : 'plus'}
                  </Badge>
                  <CopyButton value={variant.address} label={variant.address} iconOnly />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
