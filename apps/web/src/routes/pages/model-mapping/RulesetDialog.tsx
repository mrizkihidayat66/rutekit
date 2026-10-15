import { AlertTriangle, Check } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';

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
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { cn } from '@web/lib/cn.ts';

import { parseRuleset, planRuleset, planSize, planSummary, serialiseRuleset } from './ruleset.ts';
import { useApplyRuleset } from './use-apply-ruleset.ts';

/**
 * The whole rewrite list, as JSON.
 *
 * Editing eight rules one dialog at a time is fine. Editing thirty is not, and
 * neither is moving a set of rules between two installs — which is the same
 * problem: the list is the artifact, and the list is what an operator wants to
 * copy. So the page can hand it over as text and take it back.
 *
 * The console API has no bulk endpoint, so applying an edited ruleset means
 * working out the difference and issuing the calls that express it. The
 * difference is computed here, in full, and shown before anything is sent: the
 * operator reads "3 created, 2 updated, 1 deleted", sees the rules each count
 * refers to, and can back out. The alternative — discovering it one request at a
 * time — is how a paste from the wrong install half-rewrites a working config.
 *
 * The editor is loaded on demand. Monaco is the largest thing in the console by
 * a wide margin and this is the only place that needs it.
 */

const JsonEditor = lazy(() =>
  import('./JsonEditor.tsx').then((module) => ({ default: module.JsonEditor })),
);

/** The plan, one line per change, so the counts have something to point at. */
interface Change {
  readonly kind: 'create' | 'update' | 'delete';
  readonly pattern: string;
}

// The sign is a glyph the operator reads, not a fill, so it takes the text role.
const CHANGE_TONES: Record<Change['kind'], string> = {
  create: 'text-success-text',
  update: 'text-warning-text',
  delete: 'text-danger-text',
};

const CHANGE_SIGNS: Record<Change['kind'], string> = {
  create: '+',
  update: '~',
  delete: '−',
};

export interface RulesetDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The rules as they are saved, for both the initial text and the diff. */
  readonly rules: readonly ModelMappingRule[];
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function RulesetDialog({ open, onOpenChange, rules, restoreFocusTo }: RulesetDialogProps) {
  const apply = useApplyRuleset();
  const resetApply = apply.reset;
  const [text, setText] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // The editor is rebuilt from the saved list each time the dialog opens, so a
  // session's edits are never carried over into the next one. The counter is the
  // remount key: JsonEditor is created once and never re-created from a prop, so
  // a different document has to arrive as a different component instance.
  const [generation, setGeneration] = useState(0);

  // Seeding is keyed on the saved list's text rather than on its array identity,
  // because the page rebuilds that array on every render. Comparing the text
  // means a refetch that changed nothing leaves the operator's edits alone, while
  // one that did change something re-seeds rather than applying a stale diff.
  const savedText = serialiseRuleset(rules);
  const seeded = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      seeded.current = null;
      return;
    }
    if (seeded.current === savedText) return;
    seeded.current = savedText;
    setText(savedText);
    setProgress(null);
    setGeneration((value) => value + 1);
    resetApply();
  }, [open, savedText, resetApply]);

  const parsed = useMemo(() => parseRuleset(text), [text]);
  const plan = useMemo(
    () => (parsed.kind === 'ok' ? planRuleset(rules, parsed.entries) : null),
    [parsed, rules],
  );
  const total = plan === null ? 0 : planSize(plan);

  const changes = useMemo<Change[]>(() => {
    if (plan === null) return [];
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const creates: Change[] = plan.creates.map((input) => ({
      kind: 'create',
      pattern: input.pattern,
    }));
    const updates: Change[] = plan.updates.map(({ id, patch }) => ({
      kind: 'update',
      pattern: patch.pattern ?? byId.get(id)?.pattern ?? id,
    }));
    const deletes: Change[] = plan.deletes.map((id) => ({
      kind: 'delete',
      pattern: byId.get(id)?.pattern ?? id,
    }));
    return [...creates, ...updates, ...deletes];
  }, [plan, rules]);

  const pending = apply.isPending;

  const submit = () => {
    if (plan === null || total === 0) return;
    setProgress({ done: 0, total });
    apply.mutate(
      {
        plan,
        onProgress: (done, count) => {
          setProgress({ done, total: count });
        },
      },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogHeader>
          <DialogTitle>Edit the ruleset as JSON</DialogTitle>
          <DialogDescription>
            The whole list, in one document. Each rule's <code className="font-mono">id</code> is
            what ties it to a saved rule — keep it to change that rule, drop it to create a new one.
            A rule missing from the document is deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Suspense
            fallback={
              <div role="status" aria-live="polite" aria-label="Loading the JSON editor">
                <Skeleton className="h-[22rem] w-full rounded-control" />
              </div>
            }
          >
            <JsonEditor
              key={generation}
              value={text}
              onChange={setText}
              label="Mapping ruleset as JSON"
            />
          </Suspense>

          {parsed.kind === 'error' ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span className="font-mono">{parsed.message}</span>
            </p>
          ) : plan === null ? null : (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col gap-2 rounded-control border border-border p-2.5"
            >
              <p className="flex items-center gap-2 text-xs text-text">
                {total === 0 ? (
                  <>
                    <Check aria-hidden="true" className="size-3.5 text-success" />
                    Nothing changed — this matches what is saved.
                  </>
                ) : (
                  <>
                    <span className="font-medium">On apply:</span>
                    {planSummary(plan)}
                  </>
                )}
              </p>
              {changes.length === 0 ? null : (
                <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
                  {changes.map((change, index) => (
                    <li
                      key={`${change.kind}-${change.pattern}-${String(index)}`}
                      className="flex items-center gap-2 font-mono text-[0.6875rem]"
                    >
                      <span
                        aria-hidden="true"
                        className={cn('w-3 text-center', CHANGE_TONES[change.kind])}
                      >
                        {CHANGE_SIGNS[change.kind]}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate text-text-muted"
                        title={change.pattern}
                      >
                        {change.pattern}
                      </span>
                      <span className="sr-only">{change.kind}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {apply.error === null || apply.error === undefined ? null : (
            <p
              role="alert"
              className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
            >
              {apply.error.message}
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
          <Button onClick={submit} loading={pending} disabled={plan === null || total === 0}>
            {progress === null
              ? 'Apply ruleset'
              : `Applying… ${String(progress.done)} of ${String(progress.total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
