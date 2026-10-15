import type { ReactNode } from 'react';

import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { useModelIds } from '@web/hooks/use-providers.ts';

import { ChipList } from './ChipList.tsx';
import { CLIENT_LABELS } from './clients.ts';
import {
  EXPIRY_OPTIONS,
  addTokens,
  ceilingBad,
  expiryPreview,
  isExpiryChoice,
  removeToken,
  resolveExpiry,
  type KeyDraft,
} from './keys.ts';

/**
 * The API-key form's fields.
 *
 * Split from the dialog that hosts it so the dialog can stay a shell — state,
 * mutations, and which step is showing — while this file is only the layout of
 * one screen's worth of inputs. Neither is anywhere near the length limit that
 * made the split worth doing, and the two now change for different reasons.
 *
 * The limits are three pairs, each pair one idea: how fast the key may go, how
 * much it may spend, and what it may reach. Expiry (FR-6.3) and the TPS ceiling
 * (FR-6.4) are capabilities the reference routers do not have, so they are given
 * the same prominence as the ones they do.
 *
 * An empty limit field means unlimited. That is the only sensible reading of a
 * blank ceiling, and the placeholder says so rather than leaving it to be
 * inferred from what the server does with a null.
 */

/** Why a model name the catalog does not have is worth a second look. */
const UNKNOWN_MODEL_HINT =
  'not in the model catalog. Check the spelling, or add it on a provider first.';

/** One numeric ceiling, with the same validation sentence on all four. */
function CeilingField({
  label,
  description,
  value,
  bad,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly bad: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field
      label={label}
      description={description}
      error={bad ? 'Whole number, or empty for unlimited.' : undefined}
    >
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          value={value}
          inputMode="numeric"
          placeholder="Unlimited"
          invalid={bad}
          className="font-mono tabular-nums"
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

export interface KeyFormProps {
  readonly draft: KeyDraft;
  /**
   * Applies an update to the draft. Deliberately an updater rather than a whole
   * draft: the chip fields commit a name and clear their own text in the same
   * event, and two replacements built from the same snapshot would leave only
   * the second standing — which would silently drop every name added by Enter,
   * by comma, or by paste.
   */
  readonly onDraftChange: (update: (draft: KeyDraft) => KeyDraft) => void;
  /** True once the operator has tried to submit, so errors stop being silent. */
  readonly touched: boolean;
  /** The instant presets are resolved against. */
  readonly now: Date;
  /**
   * The allow/deny overlap, when there is one. The only problem shown in the
   * banner, because it is the only one with no field to sit under.
   */
  readonly clash: string | undefined;
  /** The last mutation's failure, if there was one. */
  readonly failure: Error | null | undefined;
}

export function KeyForm({ draft, onDraftChange, touched, now, clash, failure }: KeyFormProps) {
  // The two model lists are checked against the console's own catalog, so a name
  // can be picked rather than remembered.
  const models = useModelIds();

  const set = <K extends keyof KeyDraft>(key: K, value: KeyDraft[K]) => {
    onDraftChange((prev) => ({ ...prev, [key]: value }));
  };

  const nameBad = touched && draft.name.trim() === '';
  // Driven by the same resolution the submit gate uses, so an expiry that cannot
  // become an instant is flagged here rather than only in the banner.
  const expiryBad = touched && resolveExpiry(draft, now) === undefined;
  const preview = draft.expiry === 'custom' ? null : expiryPreview(draft, now);

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Name"
        required
        description="What this key is for, so it can be recognised later."
        error={nameBad ? 'Give the key a name.' : undefined}
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={draft.name}
            invalid={nameBad}
            placeholder="Production gateway"
            autoComplete="off"
            maxLength={64}
            onChange={(event) => {
              set('name', event.target.value);
            }}
          />
        )}
      </Field>

      <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
        <Field
          label="Expiry"
          description={
            preview === null ? 'This key will never expire.' : `Stops working on ${preview}.`
          }
          error={expiryBad ? 'Pick a date.' : undefined}
        >
          {() => (
            <SimpleSelect
              value={draft.expiry}
              onValueChange={(next) => {
                if (isExpiryChoice(next)) set('expiry', next);
              }}
              options={[...EXPIRY_OPTIONS]}
              aria-label="When this key expires"
              className="w-full"
            />
          )}
        </Field>

        {draft.expiry === 'custom' ? (
          <Field label="Expires at" required description="Local time.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="datetime-local"
                value={draft.expiresAt}
                invalid={expiryBad}
                className="font-mono tabular-nums"
                onChange={(event) => {
                  set('expiresAt', event.target.value);
                }}
              />
            )}
          </Field>
        ) : (
          <div aria-hidden="true" className="hidden @[520px]:block" />
        )}

        <CeilingField
          label="TPS limit"
          description="Tokens per second. The router slows a key down rather than failing it."
          value={draft.tpsLimit}
          bad={touched && ceilingBad(draft.tpsLimit)}
          onChange={(value) => {
            set('tpsLimit', value);
          }}
        />

        <CeilingField
          label="Rate limit"
          description="Requests per minute."
          value={draft.rateLimitPerMinute}
          bad={touched && ceilingBad(draft.rateLimitPerMinute)}
          onChange={(value) => {
            set('rateLimitPerMinute', value);
          }}
        />

        <CeilingField
          label="Request budget"
          description="Total requests before the key is exhausted."
          value={draft.budgetRequests}
          bad={touched && ceilingBad(draft.budgetRequests)}
          onChange={(value) => {
            set('budgetRequests', value);
          }}
        />

        <CeilingField
          label="Token budget"
          description="Input plus output tokens before the key is exhausted."
          value={draft.budgetTokens}
          bad={touched && ceilingBad(draft.budgetTokens)}
          onChange={(value) => {
            set('budgetTokens', value);
          }}
        />
      </div>

      <ChipList
        label="Models allowed"
        description="Leave empty to allow every model. Adding any name turns this into an allowlist."
        placeholder="gpt-4o, …"
        values={draft.modelsAllowed}
        text={draft.modelsAllowedText}
        mono
        suggestions={models.ids}
        suggestionsLoading={models.loading}
        unknownHint={UNKNOWN_MODEL_HINT}
        onTextChange={(value) => {
          set('modelsAllowedText', value);
        }}
        onAdd={(raw) => {
          onDraftChange((prev) => ({ ...prev, modelsAllowed: addTokens(prev.modelsAllowed, raw) }));
        }}
        onRemove={(token) => {
          onDraftChange((prev) => ({
            ...prev,
            modelsAllowed: removeToken(prev.modelsAllowed, token),
          }));
        }}
      />

      <ChipList
        label="Models denied"
        description="Checked after the allowlist, so a name here always loses."
        placeholder="gpt-3.5-turbo…"
        values={draft.modelsDenied}
        text={draft.modelsDeniedText}
        mono
        suggestions={models.ids}
        suggestionsLoading={models.loading}
        unknownHint={UNKNOWN_MODEL_HINT}
        onTextChange={(value) => {
          set('modelsDeniedText', value);
        }}
        onAdd={(raw) => {
          onDraftChange((prev) => ({ ...prev, modelsDenied: addTokens(prev.modelsDenied, raw) }));
        }}
        onRemove={(token) => {
          onDraftChange((prev) => ({
            ...prev,
            modelsDenied: removeToken(prev.modelsDenied, token),
          }));
        }}
      />

      <ChipList
        label="Client-router denylist"
        description="Best-effort. Matched against a client label header, and the request is refused when one is recognised."
        placeholder="cursor, cline…"
        values={draft.clientRouterDenylist}
        text={draft.clientRouterText}
        suggestions={CLIENT_LABELS}
        unknownHint="not a label rutekit knows. It is still matched against the header, so check the spelling."
        onTextChange={(value) => {
          set('clientRouterText', value);
        }}
        onAdd={(raw) => {
          onDraftChange((prev) => ({
            ...prev,
            clientRouterDenylist: addTokens(prev.clientRouterDenylist, raw),
          }));
        }}
        onRemove={(token) => {
          onDraftChange((prev) => ({
            ...prev,
            clientRouterDenylist: removeToken(prev.clientRouterDenylist, token),
          }));
        }}
      />

      <Alerts clash={clash} failure={failure} />
    </div>
  );
}

/** The two failure sentences, in the order the operator would read them. */
function Alerts({
  clash,
  failure,
}: {
  readonly clash: string | undefined;
  readonly failure: Error | null | undefined;
}): ReactNode {
  return (
    <>
      {clash === undefined ? null : (
        <p
          role="alert"
          className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
        >
          {clash}
        </p>
      )}
      {failure === null || failure === undefined ? null : (
        <p
          role="alert"
          className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
        >
          {failure.message}
        </p>
      )}
    </>
  );
}
