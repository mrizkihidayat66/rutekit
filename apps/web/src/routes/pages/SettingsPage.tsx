import type { GeneralSettings, GeneralSettingsUpdate } from '@contracts';
import type { ReactNode } from 'react';

import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton, SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/Tabs.tsx';
import { useUrlParam } from '@web/hooks/use-url-state.ts';
import { useGeneralSettings, useUpdateGeneralSettings } from '@web/hooks/use-system.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { BackupTab } from './settings/BackupTab.tsx';
import { GeneralTab } from './settings/GeneralTab.tsx';
import { PrivacyTab } from './settings/PrivacyTab.tsx';
import { SecurityTab } from './settings/SecurityTab.tsx';
import {
  SETTINGS_TABS,
  TAB_DESCRIPTIONS,
  TAB_LABELS,
  TAB_PARAM,
  isSettingsTab,
  type SettingsTab,
} from './settings/settings.ts';

const DESCRIPTION =
  'The instance itself: who may open it, what it keeps, how it is taken out and put back, and how it behaves under load.';

/**
 * Settings: four unrelated subjects behind one tab strip.
 *
 * They share a page rather than owning four of their own because none of them is
 * a place you go to work — you visit Settings to change one thing and leave, and
 * four sidebar entries for that would crowd out the sections that are actually
 * used daily. The tab is in the URL, so each section is still a link (R6.6).
 *
 * The page gate is deliberately per-tab rather than per-page. Security reads the
 * auth record and Backup reads the manifest, and neither has anything to do with
 * the general settings record that Privacy and General edit — so a failure in
 * one endpoint does not blank the three sections that would still have worked.
 * Only the two tabs that need the record wait on it.
 */
export function SettingsPage() {
  const [tab, setTab] = useUrlParam<SettingsTab>(TAB_PARAM, 'security', SETTINGS_TABS);

  const general = useGeneralSettings();
  const update = useUpdateGeneralSettings();

  const patch = (next: GeneralSettingsUpdate): void => {
    update.mutate(next);
  };

  /** The two tabs that read the general record share its loading and error states. */
  const withRecord = (render: (record: GeneralSettings) => ReactNode): ReactNode => {
    if (general.isPending) {
      return (
        <Card>
          <Skeleton shape="title" />
          <SkeletonText lines={4} className="mt-4" />
        </Card>
      );
    }
    if (general.isError) {
      return (
        <Card>
          <StateView
            kind="error"
            title="Could not load the instance settings"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={general.isFetching}
                onClick={() => {
                  void general.refetch();
                }}
              >
                Retry
              </Button>
            }
          />
        </Card>
      );
    }
    return render(general.data);
  };

  const busy = update.isPending;

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader title="Settings" description={DESCRIPTION} />

      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (isSettingsTab(next)) setTab(next);
        }}
        className="flex flex-col gap-4"
      >
        <TabsList variant="underline" aria-label="Settings sections">
          {SETTINGS_TABS.map((value) => (
            <TabsTrigger key={value} value={value} variant="underline">
              {TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>

        <p className="text-xs text-text-muted">{TAB_DESCRIPTIONS[tab]}</p>

        {update.isError ? (
          <p role="alert" className="text-xs text-danger-text">
            That change could not be saved: {update.error.message}
          </p>
        ) : null}

        <TabsContent value="security">
          <SecurityTab />
        </TabsContent>

        <TabsContent value="privacy">
          {withRecord((record) => (
            <PrivacyTab record={record} disabled={busy} onChange={patch} />
          ))}
        </TabsContent>

        <TabsContent value="backup">
          <BackupTab />
        </TabsContent>

        <TabsContent value="general">
          {withRecord((record) => (
            <GeneralTab record={record} disabled={busy} onChange={patch} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
