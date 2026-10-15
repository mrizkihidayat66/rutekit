import { AlarmClock, Send } from 'lucide-react';
import { useState } from 'react';

import type { Job, JobItem, JobStep } from '@contracts';

import { ResetDeadline } from '@web/components/patterns/ResetCountdown.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';

/**
 * The hand-off: a worker is parked on a challenge and needs an answer.
 *
 * This is the state the whole Automation section exists for (FR-5.4). A job in
 * `needs_manual` is not failing — it is holding a browser open, mid-flow, waiting
 * for a person, and it will abandon that worker when the deadline passes. So the
 * card is loud, it counts the deadline down in the same place the answer is typed,
 * and it names the credential the answer belongs to: several workers run at once,
 * and the wrong answer sent to the wrong one is worse than no answer.
 *
 * The answer is submitted against the item, not the job, because the backend
 * routes it to the one worker that is blocked.
 */

export interface ManualAssistCardProps {
  readonly job: Job;
  readonly item: JobItem;
  readonly step: JobStep | undefined;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onSubmit: (itemId: string, solution: string) => void;
}

export function ManualAssistCard({
  job,
  item,
  step,
  submitting,
  error,
  onSubmit,
}: ManualAssistCardProps) {
  const [solution, setSolution] = useState('');
  const trimmed = solution.trim();

  const submit = () => {
    if (trimmed === '') return;
    onSubmit(item.id, trimmed);
    setSolution('');
  };

  return (
    <section
      aria-labelledby="manual-assist-title"
      className="flex animate-rise flex-col gap-3 rounded-card border border-warning/40 bg-warning/8 p-4"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-pill border border-warning/30 bg-warning/12 text-warning">
          <AlarmClock aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="manual-assist-title" className="text-sm font-semibold text-text">
            A challenge is waiting
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
            Solve it in the preview, then type the answer here. The worker resumes the moment you
            send it.
          </p>
          {step?.detail === null || step?.detail === undefined ? null : (
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-text-subtle">{step.detail}</p>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-control border border-border/60 bg-surface-1/60 px-3 py-2">
        <div className="min-w-0">
          <dt className="text-[0.6875rem] uppercase tracking-wide text-text-subtle">Credential</dt>
          <dd className="mt-0.5 truncate font-mono text-xs text-text" title={item.accountLabel}>
            {item.accountLabel}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[0.6875rem] uppercase tracking-wide text-text-subtle">Abandons in</dt>
          <dd className="mt-0.5 text-xs text-text">
            {job.manualDeadlineAt === null ? (
              'No deadline'
            ) : (
              <ResetDeadline
                at={job.manualDeadlineAt}
                zeroLabel="abandoned"
                className="text-warning-text"
              />
            )}
          </dd>
        </div>
      </dl>

      <Field
        label="Solution"
        error={error ?? undefined}
        description="The text from the challenge. Case matters."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-label="Captcha solution"
            autoComplete="off"
            spellCheck={false}
            value={solution}
            onChange={(event) => {
              setSolution(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
        )}
      </Field>

      <div className="flex justify-end">
        <Button loading={submitting} disabled={trimmed === ''} onClick={submit}>
          <Send aria-hidden="true" className="size-3.5" />
          Send answer
        </Button>
      </div>
    </section>
  );
}
