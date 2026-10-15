import type { ReactNode } from 'react';

import type { BenchmarkResult } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Drawer } from '@web/components/ui/Drawer.tsx';
import { CopyButton } from '@web/components/patterns/CopyButton.tsx';
import { formatCount, formatDurationMs, formatPercent, formatTps, formatUsd } from '@web/lib/format.ts';

import { RUN_STATUS_LABELS, RUN_STATUS_TONES, targetLabel } from './benchmark.ts';

/**
 * One cell, with the output it produced.
 *
 * The table carries the numbers; this carries the thing the numbers are about.
 * A benchmark that shows a quality score and a throughput but never the text
 * that was scored is a benchmark nobody can act on, and the preview is the only
 * copy of that text the contract holds — so it is one click from the row rather
 * than nowhere at all.
 */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[0.6875rem] text-text-subtle">{label}</dt>
      <dd className="text-xs tabular-nums text-text">{children}</dd>
    </div>
  );
}

function figure(value: number | null, format: (input: number) => string): string {
  return value === null ? '—' : format(value);
}

export interface BenchmarkCellDrawerProps {
  readonly result: BenchmarkResult | null;
  readonly variantLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function BenchmarkCellDrawer({ result, variantLabel, onOpenChange }: BenchmarkCellDrawerProps) {
  return (
    <Drawer
      open={result !== null}
      onOpenChange={onOpenChange}
      width="md"
      title={variantLabel === '' ? 'Cell' : variantLabel}
      {...(result === null ? {} : { description: targetLabel(result) })}
    >
      {result === null ? null : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Badge tone={RUN_STATUS_TONES[result.status]} size="sm">
              {RUN_STATUS_LABELS[result.status]}
            </Badge>
            <span className="font-mono text-xs text-text-muted">{targetLabel(result)}</span>
          </div>

          {result.error === null ? null : (
            <p
              role="alert"
              className="rounded-card border border-danger/40 bg-danger/8 p-3 text-xs text-danger-text"
            >
              {result.error}
            </p>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Timing</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-border bg-surface-2 p-3">
              <Row label="Time to first token">{figure(result.ttftMs, formatDurationMs)}</Row>
              <Row label="Total latency">{figure(result.latencyMs, formatDurationMs)}</Row>
            </dl>
            <p className="text-[0.6875rem] text-text-subtle">
              Two measurements, not one split in two: the wait before the first token and the whole
              response. Neither is derived from the other.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Result</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-border bg-surface-2 p-3">
              <Row label="Output tokens">
                {result.outputTokens === null ? '—' : formatCount(result.outputTokens)}
              </Row>
              <Row label="Throughput">{figure(result.tokensPerSecond, formatTps)}</Row>
              <Row label="Cost">{figure(result.costUsd, formatUsd)}</Row>
              <Row label="Quality">
                {result.qualityScore === null ? '—' : formatPercent(result.qualityScore * 100)}
              </Row>
            </dl>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Output</h3>
              {result.outputPreview === '' ? null : (
                <CopyButton value={result.outputPreview} label="Copy output" />
              )}
            </div>
            {result.outputPreview === '' ? (
              <p className="text-xs text-text-muted">
                This cell produced no output. A run that is still going has not written one yet, and
                a cell that failed never will.
              </p>
            ) : (
              <p className="rounded-card border border-border bg-surface-2 p-3 text-xs leading-relaxed whitespace-pre-wrap text-text">
                {result.outputPreview}
              </p>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
