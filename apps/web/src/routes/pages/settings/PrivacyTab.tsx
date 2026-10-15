import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { cn } from '@web/lib/cn.ts';

import { SettingRow } from './SettingRow.tsx';
import {
  durationLabel,
  payloadTtlOptions,
  telemetryRetentionOptions,
  type SettingsTabProps,
} from './settings.ts';

/**
 * What the console is allowed to keep.
 *
 * Both retention settings are the same shape of question, so they are the same
 * control: a preset list rather than a number box. The alternative — a field you
 * type minutes into — invites a value nobody can read back, and these are the
 * settings that decide how long a captured request body sits on disk, which is
 * not a thing to get wrong by a typo.
 *
 * Payload capture is off-switchable but its TTL is not, which is why the TTL
 * row dims rather than disappearing when capture is off: the value is still
 * stored, and hiding it would make it look like turning capture back on would
 * reset it.
 */
export function PrivacyTab({ record, disabled, onChange }: SettingsTabProps) {
  const captureOff = !record.payloadCaptureEnabled;

  return (
    <div className="@container">
      <Card>
        <CardHeader
          title="Payload capture"
          description="Whether the console keeps the request and response bodies it routes, and for how long."
        />

        <div className="mt-1 flex flex-col gap-4">
          <SettingRow
            label="Capture payloads"
            description="Stored redacted — credentials and keys are stripped before anything is written. Turning this off stops new captures; it does not delete the ones already kept."
            control={
              <Switch
                checked={record.payloadCaptureEnabled}
                disabled={disabled}
                aria-label="Capture payloads"
                onCheckedChange={(checked) => {
                  onChange({ payloadCaptureEnabled: checked });
                }}
              />
            }
          />

          <div className={cn(captureOff && 'opacity-55')}>
            <SettingRow
              label="Capture lifetime"
              description="How long a captured body is kept before it is dropped. Older captures go first."
              control={
                <SimpleSelect
                  size="sm"
                  className="w-36"
                  value={String(record.payloadCaptureTtlMinutes)}
                  options={payloadTtlOptions(record.payloadCaptureTtlMinutes)}
                  disabled={disabled || captureOff}
                  aria-label="Capture lifetime"
                  onValueChange={(value) => {
                    const minutes = Number.parseInt(value, 10);
                    if (Number.isFinite(minutes)) onChange({ payloadCaptureTtlMinutes: minutes });
                  }}
                />
              }
            />
          </div>

          <SettingRow
            label="Metrics retention"
            description="How long request counts, latencies and token totals are kept. This is what the usage charts read from."
            control={
              <SimpleSelect
                size="sm"
                className="w-36"
                value={String(record.telemetryRetentionMinutes)}
                options={telemetryRetentionOptions(record.telemetryRetentionMinutes)}
                disabled={disabled}
                aria-label="Metrics retention"
                onValueChange={(value) => {
                  const minutes = Number.parseInt(value, 10);
                  if (Number.isFinite(minutes)) onChange({ telemetryRetentionMinutes: minutes });
                }}
              />
            }
          />
        </div>

        <p className="mt-4 border-t border-border pt-3 text-[0.6875rem] text-text-subtle">
          Currently keeping payloads for{' '}
          <span className="tabular-nums text-text-muted">
            {durationLabel(record.payloadCaptureTtlMinutes)}
          </span>{' '}
          and metrics for{' '}
          <span className="tabular-nums text-text-muted">
            {durationLabel(record.telemetryRetentionMinutes)}
          </span>
          .
        </p>
      </Card>
    </div>
  );
}
