/**
 * Number, size and time formatting for the console.
 *
 * One locale (`en-US`) on purpose. The interface is English-only for v1
 * (ADR-0016), and pinning the locale keeps every figure identical whatever the
 * operator's OS is set to — which matters in the log and usage views, where two
 * people comparing the same screen should read the same numbers rather than
 * each seeing their own machine's decimal separator.
 *
 * These return strings meant to sit in a `tabular-nums` cell: fixed decimals,
 * no unit surprises, never `NaN`.
 */

const COUNT = new Intl.NumberFormat('en-US');

const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** A whole count with thousands separators — `1,204`. */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? COUNT.format(value) : '—';
}

/** A count shortened for a tight cell — `1.2K`, `3.4M`. */
export function formatCompact(value: number): string {
  return Number.isFinite(value) ? COMPACT.format(value) : '—';
}

/** Token counts read better shortened than as six digits. */
export function formatTokens(value: number): string {
  return Math.abs(value) < 10_000 ? formatCount(value) : formatCompact(value);
}

/** A monetary amount in USD, always two decimals — `$12.34`. */
export function formatUsd(value: number): string {
  return Number.isFinite(value) ? USD.format(value) : '—';
}

/**
 * A credit amount whose unit the provider chose — `9,812`, `$27.42`, `EUR 24.10`.
 *
 * A pool without a currency counts units (requests, tokens), one in USD is money,
 * and anything else keeps its own code rather than being silently converted.
 */
export function formatCredits(value: number, currency: string | null): string {
  if (currency === null) return formatCount(value);
  if (currency === 'USD') return formatUsd(value);
  return `${currency} ${value.toFixed(2)}`;
}

/**
 * A byte size in binary units — `1.4 GiB`. Binary (1024) rather than decimal
 * because the values come from the OS, which reports memory in binary units.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = BYTE_UNITS[exponent] ?? 'B';
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${unit}`;
}

/** A `0..1` ratio as a percentage — `98.2%`. Pass `ratio * 100` for a percent. */
export function formatRatio(ratio: number, digits = 1): string {
  return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(digits)}%` : '—';
}

/** A percent that is already `0..100`. */
export function formatPercent(percent: number, digits = 0): string {
  return Number.isFinite(percent) ? `${percent.toFixed(digits)}%` : '—';
}

/**
 * A latency or duration, scaled to the unit that reads best:
 * `340 ms`, `1.24 s`, `2m 05s`.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Throughput — `42.1 tok/s`. */
export function formatTps(tokensPerSecond: number): string {
  return Number.isFinite(tokensPerSecond) ? `${tokensPerSecond.toFixed(1)} tok/s` : '—';
}

/** A seconds count as a coarse span — `3d 4h`, `12m 30s`. */
export function formatSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(whole % 60).padStart(2, '0')}s`;
  return `${whole}s`;
}

const CLOCK = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** A timestamp as `HH:MM:SS` in the operator's local zone. */
export function formatClock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : CLOCK.format(at);
}

const HOUR = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * A timestamp as `HH:MM` — the axis tick for an hourly series, where the
 * seconds `formatClock` adds are noise and the date is implied by the window.
 */
export function formatHour(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : HOUR.format(at);
}

const DAY = new Intl.DateTimeFormat('en-US', {
  month: '2-digit',
  day: '2-digit',
});

/**
 * A timestamp as `MM-DD` — the axis tick for a series whose buckets are wider
 * than an hour, where `formatHour` would repeat the same tick several times.
 */
export function formatDay(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : DAY.format(at);
}

/** A timestamp as `YYYY-MM-DD HH:MM:SS` in the operator's local zone. */
export function formatDateTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : DATE_TIME.format(at);
}

const RELATIVE_UNITS: readonly (readonly [number, string])[] = [
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'm'],
  [1000, 's'],
];

/**
 * A timestamp as a coarse distance from now — `3m ago`, `in 2d`. Anything under
 * a second either way reads as `just now` rather than a negative or zero span,
 * so a clock skew between the mock and the browser never shows as `-1s`.
 *
 * Both directions are spelled out because expiries are future timestamps and are
 * read next to past ones: a key list shows `in 4d` for a key about to lapse and
 * `12d ago` for one that already has. A formatter that folded the future into
 * `just now` would make every unexpired date in the console read as today.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const delta = at - now;
  if (Math.abs(delta) < 1000) return 'just now';
  const future = delta > 0;
  const span = Math.abs(delta);
  for (const [unitMs, suffix] of RELATIVE_UNITS) {
    if (span >= unitMs) {
      const value = Math.floor(span / unitMs);
      return future ? `in ${value}${suffix}` : `${value}${suffix} ago`;
    }
  }
  return 'just now';
}

/** An HTTP status grouped into a semantic bucket the UI can colour by. */
export function statusBucket(status: number): 'success' | 'redirect' | 'client' | 'server' {
  if (status < 300) return 'success';
  if (status < 400) return 'redirect';
  if (status < 500) return 'client';
  return 'server';
}
