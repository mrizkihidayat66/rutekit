import { useEffect, useState } from 'react';

import type { VccBin, VccBrand } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
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
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { useGenerateVccCards, useVccBins } from '@web/hooks/use-tools.ts';
import { formatCount, formatRatio } from '@web/lib/format.ts';

import { VCC_BIN_TYPE_LABELS, VCC_BRAND_LABELS, VCC_BRANDS } from './tools.ts';

/**
 * Mint a batch of cards.
 *
 * The range is chosen, not typed. A BIN is not a number a person can reason
 * about from memory: it decides the brand, how long the number is, which issuer
 * it claims to be from, and whether the sign-up endpoints this pool is used
 * against have accepted it before. Offering the catalogue — each row carrying
 * those facts — is what makes picking one a decision rather than a guess, and it
 * is why there is no free-text field here.
 *
 * The dialog says outright that the full number is not returned. That is the one
 * thing an operator would otherwise assume wrongly: a generator that hands back
 * masked cards looks broken until you know the PAN never leaves the server.
 */

/** The contract's ceiling on one batch. */
const MAX_BATCH = 100;

/** Stands in for "let the generator pick the best-accepted range for the brand". */
const BIN_AUTO = 'auto';

interface FormState {
  brand: VccBrand;
  count: string;
  /** A BIN from the catalogue, or `BIN_AUTO`. */
  bin: string;
  holderName: string;
}

const EMPTY: FormState = {
  brand: 'visa',
  count: '10',
  bin: BIN_AUTO,
  holderName: '',
};

/** A blank field as the endpoint wants it: the text, or null. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * What a range means, in the four facts that decide whether to use it.
 *
 * Read as a sentence so the two comparisons that matter — length against the
 * brand and acceptance against the other ranges — are visible at once, rather
 * than as a table of five columns inside a dialog.
 */
function BinFacts({ bin }: { readonly bin: VccBin }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-control border border-border bg-surface-2 px-2.5 py-2">
      <span className="font-mono text-xs text-text">{bin.bin}</span>
      <span className="text-xs text-text-muted">{bin.issuer}</span>
      <Badge tone="neutral" size="sm">
        {bin.country}
      </Badge>
      <Badge tone="neutral" size="sm">
        {VCC_BIN_TYPE_LABELS[bin.type]}
      </Badge>
      <span className="text-xs text-text-subtle tabular-nums">
        {bin.length} digits · {bin.currency}
      </span>
      <Badge tone={bin.acceptance >= 0.85 ? 'success' : 'warning'} size="sm">
        {formatRatio(bin.acceptance)} accepted
      </Badge>
    </div>
  );
}

export interface GenerateVccDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function GenerateVccDialog({
  open,
  onOpenChange,
  restoreFocusTo,
}: GenerateVccDialogProps) {
  const generate = useGenerateVccCards();
  const bins = useVccBins();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setTouched(false);
    generate.reset();
  }, [open]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const brandBins = (bins.data?.bins ?? []).filter((bin) => bin.brand === form.brand);
  const chosen =
    form.bin === BIN_AUTO ? null : (brandBins.find((bin) => bin.bin === form.bin) ?? null);

  const parsedCount = Number(form.count);
  const countValid =
    Number.isInteger(parsedCount) && parsedCount >= 1 && parsedCount <= MAX_BATCH;

  const countError =
    touched && !countValid ? `A whole number between 1 and ${formatCount(MAX_BATCH)}.` : undefined;

  const close = () => {
    onOpenChange(false);
  };

  const submit = () => {
    setTouched(true);
    if (!countValid) return;

    generate.mutate(
      {
        brand: form.brand,
        count: parsedCount,
        bin: form.bin === BIN_AUTO ? null : form.bin,
        holderName: orNull(form.holderName),
      },
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
          <DialogTitle>Generate cards</DialogTitle>
          <DialogDescription>
            Mint a batch into the pool. Cards arrive active — free for the next sign-up that needs
            one — and are drawn down from there. The full number is never returned to this page,
            only its masked form.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
            <Field label="Brand" description="Decides the shape of the number.">
              {() => (
                <SimpleSelect
                  aria-label="Brand"
                  value={form.brand}
                  onValueChange={(next) => {
                    if (!VCC_BRANDS.includes(next as VccBrand)) return;
                    const brand = next as VccBrand;
                    // A range belongs to exactly one brand, so keeping the old
                    // selection would leave the picker pointing at a BIN that is
                    // not in the list it is drawn from.
                    setForm((previous) => ({ ...previous, brand, bin: BIN_AUTO }));
                  }}
                  options={VCC_BRANDS.map((value) => ({
                    value,
                    label: VCC_BRAND_LABELS[value],
                  }))}
                />
              )}
            </Field>

            <Field
              label="How many"
              required
              error={countError}
              description={`One batch, up to ${formatCount(MAX_BATCH)}.`}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_BATCH}
                  invalid={countError !== undefined}
                  value={form.count}
                  onChange={(event) => {
                    set('count', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field
            label="Issuer range"
            description="Which BIN the batch is minted under. It decides the number's length, the issuer it claims, and how the sign-up endpoints have treated it."
          >
            {() => (
              <div className="flex flex-col gap-2">
                {bins.isPending ? (
                  <Skeleton shape="block" className="h-9 w-full" />
                ) : (
                  <SimpleSelect
                    aria-label="Issuer range"
                    value={form.bin}
                    onValueChange={(next) => {
                      set('bin', next);
                    }}
                    options={[
                      {
                        value: BIN_AUTO,
                        label: `Best accepted for ${VCC_BRAND_LABELS[form.brand]}`,
                      },
                      ...brandBins.map((bin) => ({
                        value: bin.bin,
                        label: `${bin.bin} · ${bin.issuer}`,
                      })),
                    ]}
                  />
                )}
                {chosen === null ? (
                  <p className="text-xs text-text-subtle">
                    {bins.isError
                      ? 'The range catalogue could not be loaded, so the batch will use the generator’s own default.'
                      : 'The generator picks the range this brand has been accepted under most often.'}
                  </p>
                ) : (
                  <BinFacts bin={chosen} />
                )}
              </div>
            )}
          </Field>

          <Field
            label="Cardholder name"
            description="Optional. What the sign-up form will be filled with."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                autoComplete="off"
                spellCheck={false}
                placeholder="Generated Card"
                value={form.holderName}
                onChange={(event) => {
                  set('holderName', event.target.value);
                }}
              />
            )}
          </Field>

          {generate.isError ? (
            <p
              role="alert"
              className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
            >
              The batch could not be generated. Nothing was added to the pool.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" disabled={generate.isPending} onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} loading={generate.isPending}>
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
