import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import { Card, CardFooter, CardHeader } from '@web/components/ui/Card.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { useProviders } from '@web/hooks/use-providers.ts';

import { SettingRow } from './SettingRow.tsx';
import { LOG_LEVEL_OPTIONS, isLogLevel, type SettingsTabProps } from './settings.ts';

/** The whole catalog, sorted by name — a small fixed list, fetched once. */
const PROVIDERS_QUERY = {
  q: '',
  category: null,
  status: null,
  tier: 'all',
  sort: 'name',
  direction: 'asc',
  limit: 100,
} as const;

/**
 * Radix refuses an empty string as a select value, and "no default provider" is
 * a real choice rather than an absence, so it gets a name of its own.
 */
const NO_DEFAULT = '__none__';

/**
 * The name this instance goes by, and how it behaves.
 *
 * The instance name is the one field on this page that is not written on change:
 * every keystroke would be a patch, and a name is short enough that typing it out
 * and committing on blur costs nothing. Everything else here is a single
 * decision, so it saves the moment it is made.
 *
 * Low-stress mode is the setting worth explaining, because its name says nothing
 * about what it does: it makes the router prefer the cheap and the fast over the
 * best, which is what you want on a shared box or a metered plan, and what you
 * do not want when a request's quality is the point.
 */
export function GeneralTab({ record, disabled, onChange }: SettingsTabProps) {
  const catalog = useProviders(PROVIDERS_QUERY);
  const providers = useMemo(
    () => (catalog.data?.pages ?? []).flatMap((page) => page.items),
    [catalog.data],
  );

  const providerOptions = useMemo(
    () => [
      { value: NO_DEFAULT, label: 'No default' },
      ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
    ],
    [providers],
  );

  const [name, setName] = useState(record.instanceName);
  useEffect(() => {
    setName(record.instanceName);
  }, [record.instanceName]);

  const commitName = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === record.instanceName) {
      setName(record.instanceName);
      return;
    }
    onChange({ instanceName: trimmed });
  };

  const onNameKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitName();
    }
    if (event.key === 'Escape') setName(record.instanceName);
  };

  return (
    <div className="@container flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Instance"
          description="What this console calls itself. The name shows in the sidebar and in the browser tab."
        />

        <Field label="Instance name" className="mt-1">
          {({ id }) => (
            <Input
              id={id}
              value={name}
              maxLength={64}
              disabled={disabled}
              onChange={(event) => {
                setName(event.target.value);
              }}
              onBlur={commitName}
              onKeyDown={onNameKey}
            />
          )}
        </Field>

        <CardFooter>
          <p className="mr-auto text-[0.6875rem] text-text-subtle">
            Saved when you leave the field.
          </p>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader
          title="Routing"
          description="How requests are sent out when a caller does not say which provider to use."
        />

        <div className="mt-1 flex flex-col gap-4">
          <SettingRow
            label="Default provider"
            description="Where a request goes when it names a model but no provider. With none set, rutekit picks from the accounts that are healthy."
            control={
              <SimpleSelect
                size="sm"
                className="w-44"
                value={record.defaultProviderId ?? NO_DEFAULT}
                options={providerOptions}
                disabled={disabled || catalog.isPending}
                placeholder="No default"
                aria-label="Default provider"
                onValueChange={(value) => {
                  onChange({ defaultProviderId: value === NO_DEFAULT ? null : value });
                }}
              />
            }
          />

          <SettingRow
            label="Low-stress mode"
            description="Prefer the cheap, fast path over the best model. Useful on a metered plan or a shared machine."
            control={
              <Switch
                checked={record.lowStressMode}
                disabled={disabled}
                aria-label="Low-stress mode"
                onCheckedChange={(checked) => {
                  onChange({ lowStressMode: checked });
                }}
              />
            }
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Logging"
          description="How much the server writes to its own log. This is separate from the request log the console shows."
        />

        <div className="mt-1">
          <SettingRow
            label="Log level"
            description="Everything at or above the chosen level is written. Debug is loud — useful while diagnosing, not while running."
            control={
              <SegmentedControl
                value={record.logLevel}
                options={LOG_LEVEL_OPTIONS}
                aria-label="Log level"
                onValueChange={(value) => {
                  if (isLogLevel(value)) onChange({ logLevel: value });
                }}
              />
            }
          />
        </div>
      </Card>
    </div>
  );
}
