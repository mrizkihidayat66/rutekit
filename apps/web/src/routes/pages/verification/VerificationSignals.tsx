import type { ProbeSignal } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { DataTable, type DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { formatCount, formatRatio } from '@web/lib/format.ts';

import { measurementLabel } from './verification.ts';

/**
 * Every probe, and what it found.
 *
 * The suite is a fixed list, so the rows are not sorted — the order is the order
 * the probes run in, and re-ordering them would hide that two of them are
 * controls. Each row carries its own sentence, because "API surface failed" is
 * only meaningful next to what the API surface probe looks at.
 */

const columns: readonly DataTableColumn<ProbeSignal>[] = [
  {
    id: 'probe',
    header: 'Probe',
    cell: (row) => (
      <span className="flex flex-col gap-0.5">
        <span className="text-text">{row.label}</span>
        <span className="max-w-prose text-[0.6875rem] leading-relaxed text-text-subtle">
          {row.detail}
        </span>
      </span>
    ),
  },
  {
    id: 'result',
    header: 'Result',
    widthClassName: 'w-24',
    cell: (row) => (
      <Badge tone={row.passed ? 'success' : 'danger'} size="sm">
        {row.passed ? 'Consistent' : 'Diverges'}
      </Badge>
    ),
  },
  {
    id: 'confidence',
    header: 'Confidence',
    align: 'end',
    widthClassName: 'w-28',
    cell: (row) => (
      <span className="tabular-nums text-text-muted">{formatRatio(row.confidence)}</span>
    ),
  },
  {
    id: 'measurement',
    header: 'Measurement',
    align: 'end',
    widthClassName: 'w-32',
    hideBelow: 'sm',
    cell: (row) => (
      <span className={row.measurement === null ? 'text-text-subtle' : 'tabular-nums text-text-muted'}>
        {measurementLabel(row)}
      </span>
    ),
  },
  {
    id: 'samples',
    header: 'Samples',
    align: 'end',
    widthClassName: 'w-24',
    hideBelow: 'md',
    cell: (row) => <span className="tabular-nums text-text-muted">{formatCount(row.samples)}</span>,
  },
];

export interface VerificationSignalsProps {
  readonly signals: readonly ProbeSignal[];
}

export function VerificationSignals({ signals }: VerificationSignalsProps) {
  return (
    <Card flush>
      <div className="flex flex-col gap-1 p-4 pb-3">
        <h2 className="text-sm font-semibold text-text">Probes</h2>
        <p className="max-w-3xl text-xs text-text-muted">
          Each probe is a small experiment, not a question the endpoint can answer about itself.
          Confidence is how much posterior mass that probe supported, and the measurement is its raw
          reading on its own scale.
        </p>
      </div>

      <DataTable
        rows={signals}
        columns={columns}
        getRowId={(row) => row.kind}
        caption="Probe signals for this verification"
        emptyState={
          <StateView
            kind="empty"
            title="No probes reported"
            description="The run produced no usable signal. That is itself a finding — see the band above."
          />
        }
        footer={
          <p className="text-xs tabular-nums text-text-subtle">
            {formatCount(signals.length)} probe{signals.length === 1 ? '' : 's'} run
          </p>
        }
      />
    </Card>
  );
}
