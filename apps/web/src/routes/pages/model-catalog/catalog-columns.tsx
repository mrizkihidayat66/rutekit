import { Link } from 'react-router';

import type { ModelCatalogEntry } from '@contracts';

import { CapabilityChips } from '@web/components/patterns/CapabilityChips.tsx';
import { CopyButton } from '@web/components/patterns/CopyButton.tsx';
import type { DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import {
  MODEL_SOURCE_HINTS,
  MODEL_SOURCE_LABELS,
  MODEL_SOURCE_TONES,
  formatPerMTok,
} from '@web/components/patterns/model-vocabulary.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Tooltip } from '@web/components/ui/Tooltip.tsx';
import { formatTokens } from '@web/lib/format.ts';

/**
 * The Model Catalog's columns.
 *
 * The page's whole purpose is to answer "which provider serves this id, and can
 * it hold my document" — so the three values an operator came for are the three
 * that carry a copy control, and they are copyable as the exact string they
 * would paste into a config: the id as written, the context and output as the
 * plain token counts rather than the shortened `128K` the cell displays. Copying
 * the abbreviation would be copying something that does not exist.
 *
 * Columns drop out below a container width rather than squeezing (RULESET R3.6),
 * and the order they drop in is the order of the question: the provider goes
 * last, because a row without a provider is a model id with nowhere to send it.
 */

export function catalogColumns(): readonly DataTableColumn<ModelCatalogEntry>[] {
  return [
    {
      id: 'model',
      header: 'Model',
      sortKey: 'displayName',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs text-text" title={row.displayName}>
              {row.displayName}
            </span>
            {row.deprecated ? (
              <Badge tone="warning" size="sm">
                Deprecated
              </Badge>
            ) : null}
          </span>
          <span className="flex items-center gap-0.5">
            <span className="truncate font-mono text-[0.6875rem] text-text-subtle">{row.id}</span>
            <CopyButton value={row.id} label={`model id (${row.displayName})`} iconOnly />
          </span>
        </span>
      ),
    },
    {
      id: 'provider',
      header: 'Provider',
      sortKey: 'providerName',
      cell: (row) => (
        <Link
          to={`/providers/${encodeURIComponent(row.providerId)}`}
          className="inline-flex min-w-0 items-center gap-2 rounded-key outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ProviderIcon icon={row.providerIcon} size="sm" />
          <span className="truncate text-xs">{row.providerName}</span>
        </Link>
      ),
    },
    {
      id: 'context',
      header: 'Context',
      sortKey: 'contextWindow',
      align: 'end',
      cell: (row) => (
        <span className="inline-flex items-center justify-end gap-1">
          <span className="tabular-nums text-text-muted">
            {row.contextWindow === null ? '—' : formatTokens(row.contextWindow)}
          </span>
          {row.contextWindow === null ? null : (
            <CopyButton
              value={String(row.contextWindow)}
              label={`context window for ${row.displayName}`}
              iconOnly
            />
          )}
        </span>
      ),
    },
    {
      id: 'source',
      header: 'Source',
      hideBelow: 'sm',
      cell: (row) => (
        <Tooltip content={MODEL_SOURCE_HINTS[row.source]}>
          <Badge tone={MODEL_SOURCE_TONES[row.source]} size="sm">
            {MODEL_SOURCE_LABELS[row.source]}
          </Badge>
        </Tooltip>
      ),
    },
    {
      id: 'output',
      header: 'Max out',
      sortKey: 'maxOutputTokens',
      align: 'end',
      hideBelow: 'sm',
      cell: (row) => (
        <span className="inline-flex items-center justify-end gap-1">
          <span className="tabular-nums text-text-muted">
            {row.maxOutputTokens === null ? '—' : formatTokens(row.maxOutputTokens)}
          </span>
          {row.maxOutputTokens === null ? null : (
            <CopyButton
              value={String(row.maxOutputTokens)}
              label={`max output for ${row.displayName}`}
              iconOnly
            />
          )}
        </span>
      ),
    },
    {
      id: 'capabilities',
      header: 'Capabilities',
      hideBelow: 'md',
      cell: (row) => <CapabilityChips capabilities={row.capabilities} />,
    },
    {
      id: 'inputPrice',
      header: 'In /M',
      sortKey: 'inputPricePerMTok',
      align: 'end',
      hideBelow: 'md',
      cell: (row) => (
        <span className="tabular-nums text-text-muted">{formatPerMTok(row.inputPricePerMTok)}</span>
      ),
    },
    {
      id: 'outputPrice',
      header: 'Out /M',
      align: 'end',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="tabular-nums text-text-muted">
          {formatPerMTok(row.outputPricePerMTok)}
        </span>
      ),
    },
  ];
}
