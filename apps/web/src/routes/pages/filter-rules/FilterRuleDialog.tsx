import { useEffect, useState } from 'react';

import type { FilterRule } from '@contracts';

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
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { useCreateFilterRule, useUpdateFilterRule } from '@web/hooks/use-routing.ts';

import {
  FILTER_ACTIONS,
  FILTER_ACTION_HINTS,
  FILTER_ACTION_LABELS,
  FILTER_KINDS,
  FILTER_KIND_HINTS,
  FILTER_KIND_LABELS,
  FILTER_PHASES,
  FILTER_PHASE_HINTS,
  FILTER_PHASE_LABELS,
  isFilterPhase,
  type FilterAction,
  type FilterKind,
  type FilterPhase,
} from './rules.ts';

/**
 * Write a filter rule, or change one.
 *
 * A rule is four decisions and a name: what to look for, how to look for it, what
 * to do when it matches, and when in the request's life to look. The dialog asks
 * for exactly those, and the descriptions under each control say what the choice
 * means rather than what it is called — "block" and "redact" are one word apart
 * and completely different outcomes.
 *
 * The pattern field is monospaced because it is a pattern, not prose: a stray
 * space is invisible in a proportional font and changes what the rule matches.
 */

interface FormState {
  name: string;
  kind: FilterKind;
  pattern: string;
  action: FilterAction;
  phase: FilterPhase;
  enabled: boolean;
}

const EMPTY: FormState = {
  name: '',
  kind: 'regex',
  pattern: '',
  action: 'block',
  phase: 1,
  enabled: true,
};

function draftFrom(rule: FilterRule): FormState {
  return {
    name: rule.name,
    kind: rule.kind,
    pattern: rule.pattern,
    action: rule.action,
    phase: isFilterPhase(rule.phase) ? rule.phase : 1,
    enabled: rule.enabled,
  };
}

const PHASE_OPTIONS = FILTER_PHASES.map((phase) => ({
  value: String(phase),
  label: FILTER_PHASE_LABELS[phase],
}));

export interface FilterRuleDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The rule being edited, or null to write a new one. */
  readonly rule: FilterRule | null;
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function FilterRuleDialog({ open, onOpenChange, rule, restoreFocusTo }: FilterRuleDialogProps) {
  const create = useCreateFilterRule();
  const update = useUpdateFilterRule();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(rule === null ? EMPTY : draftFrom(rule));
    setTouched(false);
    create.reset();
    update.reset();
  }, [open, rule]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const nameError =
    touched && form.name.trim() === '' ? 'Give the rule a name you will recognise later.' : undefined;
  const patternError =
    touched && form.pattern === ''
      ? form.kind === 'regex'
        ? 'Enter the expression to match.'
        : 'Enter the text to match.'
      : undefined;

  const pending = create.isPending || update.isPending;
  const failed = create.isError || update.isError;

  const close = () => {
    onOpenChange(false);
  };

  const submit = () => {
    setTouched(true);
    if (form.name.trim() === '' || form.pattern === '') return;

    const input = {
      name: form.name.trim(),
      kind: form.kind,
      pattern: form.pattern,
      action: form.action,
      phase: form.phase,
      enabled: form.enabled,
    };

    if (rule === null) {
      create.mutate(input, { onSuccess: close });
      return;
    }
    update.mutate({ id: rule.id, patch: input }, { onSuccess: close });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogHeader>
          <DialogTitle>{rule === null ? 'New filter rule' : 'Edit filter rule'}</DialogTitle>
          <DialogDescription>
            The router checks every request against these rules in the order they run, so a rule that
            blocks is a rule that stops traffic.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field
            label="Name"
            required
            error={nameError}
            description="Only shown here — nothing depends on it."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                autoComplete="off"
                maxLength={64}
                placeholder="Strip API keys"
                invalid={nameError !== undefined}
                value={form.name}
                onChange={(event) => {
                  set('name', event.target.value);
                }}
              />
            )}
          </Field>

          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-2">
            <Field label="Match" description={FILTER_KIND_HINTS[form.kind]}>
              {() => (
                <SimpleSelect
                  aria-label="Match"
                  value={form.kind}
                  onValueChange={(next) => {
                    if (FILTER_KINDS.includes(next as FilterKind)) set('kind', next as FilterKind);
                  }}
                  options={FILTER_KINDS.map((value) => ({
                    value,
                    label: FILTER_KIND_LABELS[value],
                  }))}
                />
              )}
            </Field>

            <Field label="Action" description={FILTER_ACTION_HINTS[form.action]}>
              {() => (
                <SimpleSelect
                  aria-label="Action"
                  value={form.action}
                  onValueChange={(next) => {
                    if (FILTER_ACTIONS.includes(next as FilterAction)) {
                      set('action', next as FilterAction);
                    }
                  }}
                  options={FILTER_ACTIONS.map((value) => ({
                    value,
                    label: FILTER_ACTION_LABELS[value],
                  }))}
                />
              )}
            </Field>
          </div>

          <Field
            label="Pattern"
            required
            error={patternError}
            description={
              form.kind === 'regex'
                ? 'Anchors are up to you — nothing is added around it.'
                : 'Every character is taken literally, including dots and brackets.'
            }
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                autoGrow
                rows={2}
                spellCheck={false}
                placeholder={form.kind === 'regex' ? 'sk-[A-Za-z0-9]{20,}' : 'sk-live-'}
                invalid={patternError !== undefined}
                className="font-mono text-xs"
                value={form.pattern}
                onChange={(event) => {
                  set('pattern', event.target.value);
                }}
              />
            )}
          </Field>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-muted">Phase</span>
            <SegmentedControl
              aria-label="Phase"
              value={String(form.phase)}
              onValueChange={(next) => {
                const parsed = Number(next);
                if (isFilterPhase(parsed)) set('phase', parsed);
              }}
              options={PHASE_OPTIONS}
            />
            <span className="max-w-md text-[0.6875rem] text-text-subtle">
              {FILTER_PHASE_HINTS[form.phase]}
            </span>
          </div>

          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-control border border-border p-3 text-xs text-text">
            <span className="flex min-w-0 flex-col">
              <span>Enabled</span>
              <span className="text-[0.6875rem] text-text-subtle">
                A disabled rule stays saved but is skipped on every request.
              </span>
            </span>
            <Switch
              checked={form.enabled}
              aria-label="Rule enabled"
              onCheckedChange={(checked) => {
                set('enabled', checked);
              }}
            />
          </label>

          {failed ? (
            <p
              role="alert"
              className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
            >
              {rule === null
                ? 'The rule was not created. Nothing changed.'
                : 'The change was not saved. The rule is as it was.'}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {rule === null ? 'Create rule' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
