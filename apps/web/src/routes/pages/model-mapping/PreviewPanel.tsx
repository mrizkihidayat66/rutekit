import { useEffect, useRef, useState } from 'react';

import type { MappingMatch } from '@contracts';

import { Badge, type BadgeTone } from '@web/components/ui/Badge.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { usePreviewMapping } from '@web/hooks/use-routing.ts';
import { cn } from '@web/lib/cn.ts';

import {
  DEFAULT_SAMPLES,
  parseSamples,
  previewVerdict,
  summarisePreview,
  type PreviewRow,
  type PreviewVerdict,
} from './mapping.ts';

/**
 * What the rule does, shown rather than described.
 *
 * A rewrite rule is the one thing on this page whose effect is not visible from
 * its own fields: `contains` with the pattern `-preview` reads as obviously
 * harmless until it is run against `gpt-4o-preview-2024` and quietly shortens a
 * name the operator meant to keep. So the rule is tried against real ids while it
 * is being written, and each id is shown with what it becomes.
 *
 * The ids are a textarea rather than a fixed list because the question an operator
 * actually has is about *their* traffic — the names their callers send. The
 * defaults are the shapes rules are usually written for, so the panel answers
 * something useful before anything is typed.
 *
 * The run is debounced and fires only when the pattern is non-empty. A request per
 * keystroke would be a request per keystroke, and the answer to a half-typed
 * regex is not worth having.
 */

/** Long enough that a burst of typing makes one request, short enough to feel live. */
const PREVIEW_DEBOUNCE_MS = 350;

const VERDICT_TONES: Record<PreviewVerdict, BadgeTone> = {
  rewritten: 'success',
  unchanged: 'warning',
  missed: 'neutral',
};

const VERDICT_LABELS: Record<PreviewVerdict, string> = {
  rewritten: 'rewritten',
  unchanged: 'unchanged',
  missed: 'no match',
};

export interface PreviewPanelProps {
  readonly match: MappingMatch;
  readonly pattern: string;
  readonly replacement: string;
  readonly className?: string;
}

export function PreviewPanel({ match, pattern, replacement, className }: PreviewPanelProps) {
  const preview = usePreviewMapping();
  const [samplesText, setSamplesText] = useState(DEFAULT_SAMPLES.join('\n'));
  const [rows, setRows] = useState<PreviewRow[] | null>(null);

  // Responses can land out of order once the debounce is short relative to the
  // latency; only the newest request is allowed to write.
  const seq = useRef(0);
  const runPreview = preview.mutate;

  useEffect(() => {
    const samples = parseSamples(samplesText);
    if (pattern === '' || samples.length === 0) {
      setRows(null);
      return;
    }
    const ticket = seq.current + 1;
    seq.current = ticket;
    const timer = setTimeout(() => {
      runPreview(
        { match, pattern, replacement, samples },
        {
          onSuccess: (result) => {
            if (seq.current === ticket) setRows(result.results);
          },
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [match, pattern, replacement, samplesText, runPreview]);

  const summary = rows === null ? null : summarisePreview(rows);

  return (
    <div className={cn('flex flex-col gap-3 rounded-control border border-border p-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-muted">Preview</span>
        {summary === null ? (
          <span className="text-[0.6875rem] text-text-subtle">
            {pattern === '' ? 'Type a pattern to test it.' : 'Testing…'}
          </span>
        ) : (
          <span className="text-[0.6875rem] tabular-nums text-text-subtle">
            {summary.rewritten} rewritten · {summary.matched} matched · {summary.total} tried
          </span>
        )}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[0.6875rem] text-text-subtle">Model ids to try, one per line.</span>
        <Textarea
          value={samplesText}
          rows={4}
          aria-label="Sample model ids, one per line"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => {
            setSamplesText(event.target.value);
          }}
        />
      </label>

      {rows === null ? null : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-control border border-border">
          {rows.map((row, index) => {
            const verdict = previewVerdict(row);
            return (
              <li
                key={`${row.input}-${String(index)}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-xs"
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono text-text-muted"
                  title={row.input}
                >
                  {row.input}
                </span>
                <span aria-hidden="true" className="text-text-subtle">
                  →
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-mono',
                    verdict === 'missed' ? 'text-text-subtle line-through' : 'text-text',
                  )}
                  title={row.output}
                >
                  {row.output}
                </span>
                <Badge tone={VERDICT_TONES[verdict]} size="sm">
                  {VERDICT_LABELS[verdict]}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
