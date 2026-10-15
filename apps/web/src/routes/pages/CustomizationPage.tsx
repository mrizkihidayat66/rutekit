import { RotateCcw } from 'lucide-react';

import type { CustomizationUpdate } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton, SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useCustomization, useUpdateCustomization } from '@web/hooks/use-system.ts';
import { applyTheme } from '@web/lib/theme.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { AppearancePreview } from './customization/AppearancePreview.tsx';
import { BackgroundCard } from './customization/BackgroundCard.tsx';
import { BrandingCard } from './customization/BrandingCard.tsx';
import { EffectsCard } from './customization/EffectsCard.tsx';
import { CUSTOMIZATION_DEFAULTS } from './customization/customization.ts';

const DESCRIPTION =
  'How the console looks: the mark in the sidebar, what sits behind it, and how the surfaces over it behave. Every change is applied to the whole app as you make it.';

const GRID = 'grid gap-4 @[900px]:grid-cols-[minmax(0,1fr)_20rem] @[900px]:items-start';

/**
 * Customization: the operator's own console.
 *
 * These settings are unlike every other page's, because none of them are data —
 * they are the frame the data is read in. That changes two things.
 *
 * First, they are written optimistically and the cache is what the UI reads, so
 * a slider follows the finger rather than a round trip; `AppearanceLayer` paints
 * from the same record, which means dragging the opacity slider moves the
 * background behind this page as you drag it. There is no preview mode and no
 * save button, because there is nothing to preview — you are looking at it.
 *
 * Second, the page is arranged around a small still frame. The rest of the
 * console is a poor thing to judge a background against, since it sits behind
 * everything and scrolls away; the miniature in the second column is fixed and
 * built from the same tokens, so its surfaces go translucent exactly as the real
 * ones do.
 *
 * Theme is the one setting that is not purely this record's: it also lives in
 * `localStorage`, because the pre-paint script in `index.html` has to know it
 * before React runs. `ThemeToggle` writes both, so the reset button has to as
 * well.
 */
export function CustomizationPage() {
  const customization = useCustomization();
  const update = useUpdateCustomization();

  const patch = (next: CustomizationUpdate): void => {
    update.mutate(next);
  };

  const reset = (): void => {
    update.mutate(CUSTOMIZATION_DEFAULTS);
    applyTheme(CUSTOMIZATION_DEFAULTS.theme);
  };

  if (customization.isPending) {
    return (
      <div className="@container flex min-h-full flex-col gap-5 p-5">
        <PageHeader title="Customization" description={DESCRIPTION} />
        <div className={GRID}>
          <div className="flex flex-col gap-4">
            {[0, 1, 2].map((key) => (
              <Card key={key}>
                <Skeleton shape="title" />
                <SkeletonText lines={3} className="mt-4" />
              </Card>
            ))}
          </div>
          <Card>
            <Skeleton shape="title" />
            <SkeletonText lines={6} className="mt-4" />
          </Card>
        </div>
      </div>
    );
  }

  if (customization.isError) {
    return (
      <div className="@container flex min-h-full flex-col gap-5 p-5">
        <PageHeader title="Customization" description={DESCRIPTION} />
        <Card>
          <StateView
            kind="error"
            title="Could not load your appearance settings"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={customization.isFetching}
                onClick={() => {
                  void customization.refetch();
                }}
              >
                Retry
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const record = customization.data;
  const busy = update.isPending;

  return (
    <div className="@container flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Customization"
        description={DESCRIPTION}
        actions={
          <Button variant="secondary" size="sm" disabled={busy} onClick={reset}>
            <RotateCcw aria-hidden="true" className="size-3.5" />
            Reset
          </Button>
        }
      />

      {update.isError ? (
        <p role="alert" className="text-xs text-danger-text">
          That change could not be saved: {update.error.message}
        </p>
      ) : null}

      <div className={GRID}>
        <div className="flex min-w-0 flex-col gap-4">
          <BrandingCard record={record} disabled={busy} onChange={patch} />
          <BackgroundCard record={record} disabled={busy} onChange={patch} />
          <EffectsCard record={record} disabled={busy} onChange={patch} />
        </div>

        <div className="@[900px]:sticky @[900px]:top-5">
          <AppearancePreview />
        </div>
      </div>
    </div>
  );
}
