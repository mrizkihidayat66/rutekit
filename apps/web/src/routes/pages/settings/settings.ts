import type { GeneralSettings, GeneralSettingsUpdate, LogLevel } from '@contracts';

/**
 * The Settings page's vocabulary.
 *
 * Four sections that have nothing to do with each other except that they are all
 * about the instance rather than the traffic through it. They are tabs on one
 * page rather than four pages because they are read rarely and always together —
 * an operator opening Settings is usually about to export, and wants to see what
 * the export would carry on the way past.
 */

export const SETTINGS_TABS = ['security', 'privacy', 'backup', 'general'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tab lives in the URL, so a section is a link (RULESET R6.6). */
export const TAB_PARAM = 'tab';

export function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab === value);
}

export const TAB_LABELS: Record<SettingsTab, string> = {
  security: 'Security',
  privacy: 'Privacy',
  backup: 'Backup & Restore',
  general: 'General',
};

export const TAB_OPTIONS = SETTINGS_TABS.map((value) => ({
  value,
  label: TAB_LABELS[value],
}));

export const TAB_DESCRIPTIONS: Record<SettingsTab, string> = {
  security: 'The password that opens this console, and the session it opened.',
  privacy: 'What the console is allowed to keep about the traffic through it.',
  backup: 'Take the whole instance out as one file, or put one back.',
  general: 'The name this instance goes by, and how it behaves under load.',
};

/* ---- Shared ---- */

/**
 * What the General and Privacy tabs are handed.
 *
 * The same shape the Customization page's cards take, and for the same reason:
 * these records are written optimistically, so a control is a function of the
 * cached record and a patch, with no local draft and no save button.
 */
export interface SettingsTabProps {
  readonly record: GeneralSettings;
  readonly disabled: boolean;
  readonly onChange: (patch: GeneralSettingsUpdate) => void;
}

/* ---- General ---- */

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'Debug',
  info: 'Info',
  warn: 'Warning',
  error: 'Error',
};

export const LOG_LEVEL_OPTIONS = LOG_LEVELS.map((value) => ({
  value,
  label: LOG_LEVEL_LABELS[value],
}));

export function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

/* ---- Privacy ---- */

/**
 * Retention as a short list of presets rather than a number box.
 *
 * Both of these are "how long should this be kept" questions, and the honest
 * answer is always one of a handful of spans — nobody means 3 047 minutes. A
 * preset is also what keeps the value legible after the fact: `10080` in a
 * number box says nothing, "7 days" does.
 */
const PAYLOAD_TTL_MINUTES = [60, 360, 1_440, 10_080] as const;
const TELEMETRY_RETENTION_MINUTES = [1_440, 10_080, 43_200, 129_600] as const;

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 24) return hours === 1 ? '1 hour' : `${String(hours)} hours`;
  const days = hours / 24;
  return days === 1 ? '1 day' : `${String(days)} days`;
}

/** The presets, plus whatever the record already holds if it is not one of them. */
function retentionOptions(
  presets: readonly number[],
  current: number,
): Array<{ value: string; label: string }> {
  const all = presets.includes(current)
    ? [...presets]
    : [...presets, current].sort((left, right) => left - right);
  return all.map((value) => ({ value: String(value), label: durationLabel(value) }));
}

export function payloadTtlOptions(current: number) {
  return retentionOptions(PAYLOAD_TTL_MINUTES, current);
}

export function telemetryRetentionOptions(current: number) {
  return retentionOptions(TELEMETRY_RETENTION_MINUTES, current);
}

/* ---- Backup ---- */

/** The archive a restore expects, and what the file picker will offer. */
export const ARCHIVE_ACCEPT = '.json,application/json';

/**
 * Strip the `data:` prefix from a data URL.
 *
 * The restore endpoint takes the archive as a bare base64 payload, and a
 * `FileReader` only ever hands back a data URL — so the prefix comes off here
 * rather than in the component, where it would be one more thing to notice.
 */
export function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}
