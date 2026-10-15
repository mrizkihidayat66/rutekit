import { Plus, X } from 'lucide-react';

import type { BenchmarkAssertion } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';

import {
  ASSERTION_KINDS,
  ASSERTION_LABELS,
  ASSERTION_PLACEHOLDERS,
  emptyAssertion,
} from './benchmark.ts';

/**
 * What each answer is scored against (FR-9.2).
 *
 * A run without a rubric still measures — first token, latency, tokens a second,
 * cost — and that is a legitimate benchmark. What it cannot say is whether the
 * answers were any *good*, and the score column reads "—" for every cell. So this
 * panel is optional by design and says so, rather than presenting an empty list
 * as something that was left unfinished.
 *
 * **The score is the fraction of these that pass**, which is why the panel shows
 * the count rather than hiding it: three checks mean a cell can score 0, ⅓, ⅔ or
 * 1, and an operator reading a 0.67 should be able to see immediately that it is
 * two of three rather than something fuzzier.
 *
 * A row is edited in place with no save step, and a half-typed row is not an
 * error — `toInput` drops the ones that would match everything, so a `contains`
 * with no phrase is simply not sent.
 */
export interface BenchmarkRubricEditorProps {
  readonly rubric: readonly BenchmarkAssertion[];
  readonly onChange: (rubric: readonly BenchmarkAssertion[]) => void;
}

export function BenchmarkRubricEditor({ rubric, onChange }: BenchmarkRubricEditorProps) {
  const replace = (index: number, assertion: BenchmarkAssertion): void => {
    onChange(rubric.map((entry, at) => (at === index ? assertion : entry)));
  };

  const remove = (index: number): void => {
    onChange(rubric.filter((_entry, at) => at !== index));
  };

  const add = (): void => {
    onChange([...rubric, emptyAssertion('contains')]);
  };

  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-text-muted">Scoring</span>
        <span className="text-[0.6875rem] text-text-subtle">
          {rubric.length === 0
            ? 'Optional. Without checks the run measures speed and cost, and every score reads “—”.'
            : `Each cell is scored on how many of these ${String(rubric.length)} it passes.`}
        </span>
      </div>

      {rubric.map((assertion, index) => (
        <div key={index} className="flex items-start gap-2">
          <SimpleSelect
            aria-label={`Check ${String(index + 1)} kind`}
            value={assertion.kind}
            onValueChange={(value) => {
              // A kind change starts the row over rather than carrying a value
              // across: "a phrase" and "a character count" are not the same
              // field, and a 400 that used to be a length would become a phrase
              // nobody wrote.
              const kind = ASSERTION_KINDS.find((entry) => entry === value) ?? 'contains';
              replace(index, emptyAssertion(kind));
            }}
            options={ASSERTION_KINDS.map((kind) => ({ value: kind, label: ASSERTION_LABELS[kind] }))}
            className="w-52 shrink-0"
          />

          {assertion.kind === 'max_length' ? (
            <Input
              type="number"
              min={1}
              aria-label={`Check ${String(index + 1)} limit`}
              value={assertion.value === 0 ? '' : String(assertion.value)}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                replace(index, {
                  kind: 'max_length',
                  value: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
                });
              }}
              className="min-w-0 flex-1"
            />
          ) : (
            <Input
              aria-label={`Check ${String(index + 1)} value`}
              spellCheck={false}
              autoComplete="off"
              placeholder={ASSERTION_PLACEHOLDERS[assertion.kind]}
              value={assertion.value}
              onChange={(event) => {
                replace(index, { kind: assertion.kind, value: event.target.value });
              }}
              className="min-w-0 flex-1 font-mono text-xs"
            />
          )}

          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove check ${String(index + 1)}`}
            onClick={() => {
              remove(index);
            }}
          >
            <X aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      ))}

      <div>
        <Button variant="secondary" size="sm" onClick={add}>
          <Plus aria-hidden="true" className="size-3.5" />
          Add a check
        </Button>
      </div>
    </div>
  );
}
