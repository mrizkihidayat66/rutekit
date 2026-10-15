import { useEffect, useState } from 'react';

import type { ModelMappingRule } from '@contracts';

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
import { Switch } from '@web/components/ui/Switch.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { useCreateMapping, useUpdateMapping } from '@web/hooks/use-routing.ts';

import { PreviewPanel } from './PreviewPanel.tsx';
import {
  EMPTY_DRAFT,
  MATCH_HINTS,
  MATCH_OPTIONS,
  draftFromRule,
  draftProblem,
  inputFromDraft,
  parsePriority,
  patternProblem,
  type RuleDraft,
} from './mapping.ts';

/**
 * Write one rewrite rule.
 *
 * A single form for both creating and editing, because the fields are the same
 * and the difference — whether there is an id yet — is the only thing that
 * changes what the button does.
 *
 * Priority is a number field rather than a drag handle. Ordering these rules is
 * not a matter of taste the way a chain's order is: the rules run in ascending
 * priority and the first match wins, so a rule's position is a claim about which
 * other rules it should pre-empt. That claim is worth stating as a number the
 * operator can see and reason about, and it survives being exported to JSON
 * unchanged — which is the other half of this page.
 *
 * The preview sits inside the form so that the rule can be checked against real
 * ids before it is saved. It is the whole reason a rewrite rule is safe to write.
 */

export interface RuleEditDialogProps {
  readonly rule: ModelMappingRule | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The priority a new rule starts at, taken from the rules already saved. */
  readonly suggestedPriority: number;
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function RuleEditDialog({
  rule,
  open,
  onOpenChange,
  suggestedPriority,
  restoreFocusTo,
}: RuleEditDialogProps) {
  const create = useCreateMapping();
  const update = useUpdateMapping();
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(
      rule === null ? { ...EMPTY_DRAFT, priority: String(suggestedPriority) } : draftFromRule(rule),
    );
    setTouched(false);
    create.reset();
    update.reset();
  }, [open, rule, suggestedPriority]);

  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  const problem = touched ? draftProblem(draft) : undefined;
  const patternBad = touched && patternProblem(draft) !== undefined;
  const priorityBad = touched && parsePriority(draft.priority) === undefined;
  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;

  const submit = () => {
    setTouched(true);
    const input = inputFromDraft(draft);
    if (input === undefined) return;
    const close = () => {
      onOpenChange(false);
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
        size="lg"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogHeader>
          <DialogTitle>{rule === null ? 'New rewrite rule' : 'Edit rewrite rule'}</DialogTitle>
          <DialogDescription>
            A rule rewrites the model id a client sends before routing looks at it. Rules run in
            ascending priority and the first one that matches wins.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 @[520px]:grid-cols-[minmax(0,1fr)_7rem]">
            <Field label="Match" description={MATCH_HINTS[draft.match]}>
              {() => (
                <SimpleSelect
                  value={draft.match}
                  onValueChange={(next) => {
                    if (next === 'exact' || next === 'contains' || next === 'regex') {
                      set('match', next);
                    }
                  }}
                  options={[...MATCH_OPTIONS]}
                  aria-label="How the pattern is matched"
                  className="w-full"
                />
              )}
            </Field>

            <Field
              label="Priority"
              required
              description="Lower runs first."
              error={priorityBad ? 'Whole number, please.' : undefined}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={draft.priority}
                  inputMode="numeric"
                  invalid={priorityBad}
                  className="font-mono tabular-nums"
                  onChange={(event) => {
                    set('priority', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field
            label={draft.match === 'regex' ? 'Pattern (regular expression)' : 'Pattern'}
            required
            description="The id, or the part of it, to look for."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={draft.pattern}
                invalid={patternBad}
                placeholder={
                  draft.match === 'regex' ? '^gpt-4o-(\\d{4}-\\d{2}-\\d{2})$' : 'gpt-4-turbo'
                }
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                onChange={(event) => {
                  set('pattern', event.target.value);
                }}
              />
            )}
          </Field>

          <Field
            label="Replacement"
            description={
              draft.match === 'exact'
                ? 'The id clients should get instead. May be empty.'
                : 'Put in place of the match. May be empty to strip it.'
            }
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={draft.replacement}
                placeholder="gpt-4.1"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                onChange={(event) => {
                  set('replacement', event.target.value);
                }}
              />
            )}
          </Field>

          <Field
            label="Note"
            description="Optional. Shown on the list so the rule explains itself."
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                value={draft.description}
                maxLength={280}
                rows={2}
                autoGrow
                placeholder="Why this rule exists."
                onChange={(event) => {
                  set('description', event.target.value);
                }}
              />
            )}
          </Field>

          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-control border border-border p-3 text-xs text-text">
            <span className="flex min-w-0 flex-col">
              <span>Enabled</span>
              <span className="text-[0.6875rem] text-text-subtle">
                A disabled rule stays saved but is skipped.
              </span>
            </span>
            <Switch
              checked={draft.enabled}
              aria-label="Rule enabled"
              onCheckedChange={(checked) => {
                set('enabled', checked);
              }}
            />
          </label>

          <PreviewPanel
            match={draft.match}
            pattern={draft.pattern}
            replacement={draft.replacement}
          />

          {problem === undefined ? null : (
            <p
              role="alert"
              className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
            >
              {problem}
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
            {rule === null ? 'Create rule' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
