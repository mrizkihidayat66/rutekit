import type { TimeWindow, UsageBreakdownDimension, UsageMetric, UsagePoint } from '@contracts';
import { TIME_WINDOWS } from '@contracts';

import type { ChartSeries } from '@web/components/patterns/AreaChart.tsx';
import type { Tone } from '@web/components/patterns/tone.ts';
import { formatCount, formatTokens, formatUsd, statusBucket } from '@web/lib/format.ts';

/**
 * The Usage page's vocabulary.
 *
 * Which metrics the chart may draw, which windows the operator may ask for, and
 * which dimension the breakdown splits by — all in one file so the URL parser,
 * the toggle and the chart agree on what a value means. Nothing here renders, so
 * it can be imported by any of the page's components without breaking fast
 * refresh.
 *
 * The metric list is the whole legend: each entry carries the tone its series is
 * drawn in, so the chips above the chart double as the key and there is no
 * second place for the colours to drift out of step.
 */

export interface MetricDefinition {
  readonly key: UsageMetric;
  readonly label: string;
  readonly tone: Tone;
  readonly value: (point: UsagePoint) => number;
  readonly format: (value: number) => string;
}

export const METRICS: readonly MetricDefinition[] = [
  { key: 'requests', label: 'Requests', tone: 'accent', value: (point) => point.requests, format: formatCount },
  { key: 'errors', label: 'Errors', tone: 'danger', value: (point) => point.errors, format: formatCount },
  { key: 'inputTokens', label: 'Input tokens', tone: 'info', value: (point) => point.inputTokens, format: formatTokens },
  { key: 'outputTokens', label: 'Output tokens', tone: 'success', value: (point) => point.outputTokens, format: formatTokens },
  {
    key: 'cachedInputTokens',
    label: 'Cached tokens',
    tone: 'warning',
    value: (point) => point.cachedInputTokens,
    format: formatTokens,
  },
  { key: 'costUsd', label: 'Cost', tone: 'neutral', value: (point) => point.costUsd, format: formatUsd },
];

const METRIC_BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]));
const METRIC_ORDER = METRICS.map((metric) => metric.key);
const METRIC_KEYS = new Set<string>(METRIC_ORDER);

export function metricByKey(key: UsageMetric): MetricDefinition {
  const found = METRIC_BY_KEY.get(key);
  if (found === undefined) throw new Error(`unknown usage metric: ${key}`);
  return found;
}

/** The metric a fresh visit plots. */
export const DEFAULT_METRIC: UsageMetric = 'requests';

/**
 * Read `?metrics=requests,errors` back into keys we know, in catalogue order.
 * An empty or wholly unrecognised value falls back rather than drawing nothing,
 * so a hand-edited URL still renders a chart.
 */
export function parseMetrics(raw: string): readonly UsageMetric[] {
  const picked = new Set(raw.split(',').filter((part) => METRIC_KEYS.has(part)));
  const ordered = METRIC_ORDER.filter((key) => picked.has(key));
  return ordered.length === 0 ? [DEFAULT_METRIC] : ordered;
}

/** Add or remove one metric, never emptying the set — a chart with no series is not a chart. */
export function toggleMetric(
  selected: readonly UsageMetric[],
  key: UsageMetric,
): readonly UsageMetric[] {
  const has = selected.includes(key);
  if (has && selected.length === 1) return selected;
  const next = has ? selected.filter((entry) => entry !== key) : [...selected, key];
  return METRIC_ORDER.filter((entry) => next.includes(entry));
}

export function toChartSeries(
  metric: MetricDefinition,
  points: readonly UsagePoint[],
): ChartSeries {
  return {
    key: metric.key,
    label: metric.label,
    tone: metric.tone,
    values: points.map((point) => metric.value(point)),
    format: metric.format,
  };
}

/** A sentence naming what the chart is showing, for assistive technology. */
export function describeMetrics(selected: readonly UsageMetric[]): string {
  const names = selected.map((key) => metricByKey(key).label.toLowerCase());
  if (names.length === 1) return names[0] ?? 'requests';
  if (names.length === 2) return `${names[0] ?? ''} and ${names[1] ?? ''}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

export const WINDOW_LABELS: Record<TimeWindow, string> = {
  '1h': '1h',
  '6h': '6h',
  '12h': '12h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All',
};

/** Reads as a clause in a card description — "over the last 24 hours". */
export const WINDOW_PHRASE: Record<TimeWindow, string> = {
  '1h': 'the last hour',
  '6h': 'the last 6 hours',
  '12h': 'the last 12 hours',
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  all: 'all time',
};

export const WINDOWS = TIME_WINDOWS;
export const DEFAULT_WINDOW: TimeWindow = '24h';

export interface DimensionOption {
  readonly key: UsageBreakdownDimension;
  readonly label: string;
}

export const DIMENSIONS: readonly DimensionOption[] = [
  { key: 'provider', label: 'Provider' },
  { key: 'model', label: 'Model' },
  { key: 'account', label: 'Account' },
  { key: 'apiKey', label: 'API key' },
  { key: 'status', label: 'Status' },
];

export const DIMENSION_KEYS = DIMENSIONS.map((dimension) => dimension.key);
export const DEFAULT_DIMENSION: UsageBreakdownDimension = 'provider';

/** Narrows the string a select hands back to a dimension the API accepts. */
export function isDimension(value: string): value is UsageBreakdownDimension {
  return (DIMENSION_KEYS as readonly string[]).includes(value);
}

export const DIMENSION_SELECT_OPTIONS = DIMENSIONS.map((dimension) => ({
  value: dimension.key,
  label: dimension.label,
}));

/** A status breakdown colours by HTTP class; every other dimension is one bar colour. */
export function breakdownTone(dimension: UsageBreakdownDimension, key: string): Tone {
  if (dimension !== 'status') return 'accent';
  const status = Number(key);
  if (!Number.isInteger(status)) return 'neutral';
  switch (statusBucket(status)) {
    case 'success':
      return 'success';
    case 'redirect':
      return 'info';
    case 'client':
      return 'warning';
    case 'server':
      return 'danger';
  }
}

export const OUTCOMES = ['all', 'errors', 'success'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABELS: Record<Outcome, string> = {
  all: 'All',
  errors: 'Errors',
  success: 'Success',
};

export const DEFAULT_OUTCOME: Outcome = 'all';

/** The one place the page decides when a success rate stops being reassuring. */
export function successRateTone(rate: number): Tone {
  if (rate >= 0.99) return 'success';
  if (rate >= 0.95) return 'warning';
  return 'danger';
}
