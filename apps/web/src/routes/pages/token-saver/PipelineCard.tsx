import { ShieldCheck } from 'lucide-react';

import type { TokenSaverConfig, TokenSaverConfigUpdate } from '@contracts';
import { CAVEMAN_TIERS, RTK_PRESETS, RTK_PRESET_FILTERS } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '@web/components/ui/Card.tsx';
import { Checkbox } from '@web/components/ui/Checkbox.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { useTokenSaverConfig, useUpdateTokenSaver } from '@web/hooks/use-token-saver.ts';
import { cn } from '@web/lib/cn.ts';

import {
  countEnabledFilters,
  FILTERS,
  FILTERS_BY_GROUP,
  GROUP_HINTS,
  GROUP_LABELS,
  matchesPreset,
  NATURE_LABELS,
  NATURE_TONES,
  PRESET_HINTS,
  PRESET_LABELS,
  STAGES,
  TIER_HINTS,
  TIER_LABELS,
  TIER_SAVINGS,
  withFilter,
  withStage,
  type StageMeta,
} from './savers.ts';

/**
 * The compression pipeline: five stages, each with its own switch.
 *
 * The stages are shown in the order they run, because that order is the whole
 * design — tool schemas are compacted before the conversation, and the cache
 * boundary is marked last. Reordering them would not be a preference, it would
 * be a different pipeline, so the list is not sortable and not draggable.
 *
 * The detail for the two stages that carry their own settings (RTK's filter set,
 * Caveman's rewrite level) opens underneath the stage rather than in a dialog,
 * so an operator can see at a glance that a stage is on *and* what it is doing.
 */

const MASTER_DESCRIPTION =
  'Five stages run in order on every outbound request. Each is independent and fail-open, so a misconfiguration costs savings rather than a turn.';

const FAIL_OPEN_NOTE =
  'Every stage fails open: if one errors, the request is forwarded untouched and the console logs it. The worst a bad setting can do is save nothing — never drop a turn.';

export function PipelineCard() {
  const query = useTokenSaverConfig();
  const update = useUpdateTokenSaver();

  if (query.isPending) return <PipelineSkeleton />;

  if (query.isError || query.data === undefined) {
    return (
      <Card>
        <StateView
          kind="error"
          title="Could not load the pipeline settings"
          description="The console API did not answer. Check that the server is running, then try again."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void query.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      </Card>
    );
  }

  const config = query.data;
  const patch = (next: TokenSaverConfigUpdate) => {
    update.mutate(next);
  };

  return (
    <Card>
      <CardHeader
        title="Compression pipeline"
        description={MASTER_DESCRIPTION}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={config.enabled ? 'success' : 'neutral'} dot>
              {config.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <Switch
              checked={config.enabled}
              onCheckedChange={(on) => {
                patch({ enabled: on });
              }}
              aria-label="Enable the compression pipeline"
            />
          </div>
        }
      />

      <CardBody>
        <ul className="divide-y divide-border">
          {STAGES.map((stage, index) => (
            <StageRow key={stage.id} index={index} stage={stage} config={config} onPatch={patch} />
          ))}
        </ul>

        <p className="mt-4 flex items-start gap-2 rounded-control border border-info/25 bg-info/10 px-3 py-2 text-[0.6875rem] text-info-text">
          <ShieldCheck aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {FAIL_OPEN_NOTE}
        </p>
      </CardBody>
    </Card>
  );
}

interface StageRowProps {
  readonly index: number;
  readonly stage: StageMeta;
  readonly config: TokenSaverConfig;
  readonly onPatch: (patch: TokenSaverConfigUpdate) => void;
}

function StageRow({ index, stage, config, onPatch }: StageRowProps) {
  const on = config.stages[stage.id];
  // A stage only runs when the pipeline is on *and* its own switch is on. The
  // row says which of the two is missing by dimming, so a stage that is on but
  // unreachable does not read as if it were working.
  const live = config.enabled && on;

  return (
    <li className="py-4 first:pt-1 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-pill border text-[0.6875rem] font-medium tabular-nums',
              live
                ? 'border-accent/30 bg-accent/10 text-accent'
                : 'border-border bg-surface-2 text-text-subtle',
            )}
          >
            {index + 1}
          </span>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cn('text-sm font-medium', live ? 'text-text' : 'text-text-muted')}>
                {stage.label}
              </span>
              <Badge tone={NATURE_TONES[stage.nature]} size="sm">
                {NATURE_LABELS[stage.nature]}
              </Badge>
              <span className="text-[0.6875rem] text-text-subtle">{stage.savings}</span>
            </div>
            <p className="mt-1 max-w-2xl text-xs text-text-muted">{stage.description}</p>
          </div>
        </div>

        <Switch
          size="sm"
          checked={on}
          onCheckedChange={(next) => {
            onPatch({ stages: withStage(config.stages, stage.id, next) });
          }}
          aria-label={`Enable ${stage.label}`}
        />
      </div>

      {stage.id === 'rtk' && on ? <RtkDetail config={config} onPatch={onPatch} /> : null}
      {stage.id === 'caveman' && on ? <CavemanDetail config={config} onPatch={onPatch} /> : null}
    </li>
  );
}

interface DetailProps {
  readonly config: TokenSaverConfig;
  readonly onPatch: (patch: TokenSaverConfigUpdate) => void;
}

function RtkDetail({ config, onPatch }: DetailProps) {
  const custom = !matchesPreset(config.rtkFilters, config.rtkPreset);
  const enabled = countEnabledFilters(config.rtkFilters);

  return (
    <div className="mt-3 ml-9 rounded-control border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text">Aggressiveness</span>
          {custom ? (
            <Badge tone="neutral" size="sm">
              Custom
            </Badge>
          ) : null}
        </div>

        <SegmentedControl
          value={config.rtkPreset}
          onValueChange={(preset) => {
            onPatch({ rtkPreset: preset, rtkFilters: { ...RTK_PRESET_FILTERS[preset] } });
          }}
          options={RTK_PRESETS.map((preset) => ({ value: preset, label: PRESET_LABELS[preset] }))}
          aria-label="RTK aggressiveness preset"
        />
      </div>

      <p className="mt-1 text-[0.6875rem] text-text-subtle">{PRESET_HINTS[config.rtkPreset]}</p>

      <div className="mt-3 space-y-3">
        {FILTERS_BY_GROUP.map(({ group, filters }) => (
          <fieldset key={group} className="min-w-0">
            <legend className="text-[0.6875rem] font-medium tracking-wide text-text-subtle uppercase">
              {GROUP_LABELS[group]}
            </legend>
            <p className="mt-0.5 text-[0.6875rem] text-text-subtle">{GROUP_HINTS[group]}</p>

            <div className="mt-1.5 grid gap-x-4 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
              {filters.map((filter) => (
                <label key={filter.id} className="flex cursor-pointer items-start gap-2">
                  <Checkbox
                    className="mt-0.5"
                    checked={config.rtkFilters[filter.id]}
                    onChange={(event) => {
                      onPatch({
                        rtkFilters: withFilter(config.rtkFilters, filter.id, event.target.checked),
                      });
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs text-text">{filter.label}</span>
                    <span className="block text-[0.6875rem] text-text-subtle">
                      {filter.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      {enabled === 0 ? (
        <p className="mt-3 text-[0.6875rem] text-warning-text">
          No filter is on, so RTK passes every result through unchanged.
        </p>
      ) : (
        <p className="mt-3 text-[0.6875rem] text-text-subtle">
          {enabled} of {FILTERS.length} filters on.
        </p>
      )}
    </div>
  );
}

function CavemanDetail({ config, onPatch }: DetailProps) {
  const tier = config.cavemanTier;

  return (
    <div className="mt-3 ml-9 rounded-control border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text">Rewrite level</span>
          <span className="text-[0.6875rem] tabular-nums text-text-subtle">
            {TIER_SAVINGS[tier]}
          </span>
        </div>

        <SegmentedControl
          value={tier}
          onValueChange={(next) => {
            onPatch({ cavemanTier: next });
          }}
          options={CAVEMAN_TIERS.map((value) => ({ value, label: TIER_LABELS[value] }))}
          aria-label="Caveman rewrite level"
        />
      </div>

      <p className="mt-1 max-w-2xl text-[0.6875rem] text-text-subtle">{TIER_HINTS[tier]}</p>

      {tier === 'off' ? (
        <p className="mt-2 text-[0.6875rem] text-warning-text">
          At Off the stage is inert even with its switch on — the prompt is forwarded as written.
        </p>
      ) : null}
    </div>
  );
}

function PipelineSkeleton() {
  return (
    <Card>
      <CardHeader title="Compression pipeline" description={MASTER_DESCRIPTION} />
      <CardBody>
        <div
          role="status"
          aria-live="polite"
          aria-label="Loading the pipeline settings"
          className="space-y-4"
        >
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-start gap-3">
              <Skeleton shape="circle" className="size-6" />
              <div className="flex-1 space-y-1.5">
                <Skeleton shape="text" className="w-48" />
                <Skeleton shape="text" className="w-full max-w-lg" />
              </div>
              <Skeleton shape="text" className="h-4 w-7 shrink-0 rounded-pill" />
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
