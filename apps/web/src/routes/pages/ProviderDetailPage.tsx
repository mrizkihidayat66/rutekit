import { ArrowLeft, PackageX, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';

import { CredentialNotice } from '@web/components/patterns/CredentialNotice.tsx';
import { ImportCredentialDialog } from '@web/components/patterns/ImportCredentialDialog.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton, SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { ApiError } from '@web/data/client.ts';
import { useBreadcrumbTrail } from '@web/hooks/use-breadcrumb-trail.ts';
import { useProviderDetail } from '@web/hooks/use-providers.ts';
import { cn } from '@web/lib/cn.ts';
import type { Crumb } from '@web/shell/breadcrumb.ts';

import { AccountsCard } from './provider-detail/AccountsCard.tsx';
import { CreditPoolCard } from './provider-detail/CreditPoolCard.tsx';
import { DetailActions } from './provider-detail/DetailActions.tsx';
import { DetailHeader } from './provider-detail/DetailHeader.tsx';
import { DetailStats } from './provider-detail/DetailStats.tsx';
import { ModelsCard } from './provider-detail/ModelsCard.tsx';
import { OauthCard } from './provider-detail/OauthCard.tsx';
import { OauthReturnNotice } from './provider-detail/OauthReturnNotice.tsx';
import { RoutingStrategyCard } from './provider-detail/RoutingStrategyCard.tsx';

/**
 * One provider, everything about it.
 *
 * The page answers a single question — why is this provider behaving the way it
 * is — and the order is the order an operator asks it in: the credential notice
 * first, because a write-only key is the thing that most often looks broken when
 * it is not; then the four numbers; then the two halves of the pool (the
 * credentials, and the credit they draw from); then what the provider claims to
 * serve; and finally the routing, which is how the first two connect.
 *
 * The probes — test, fetch models, OAuth sign-in — are the only controls here
 * that change the provider, and each reports in place rather than leaving the
 * page to tell the operator what happened.
 */

function BackLink() {
  return (
    <Link
      to="/providers"
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'sm' }),
        '-ml-2 w-fit text-text-muted',
      )}
    >
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      Providers
    </Link>
  );
}

/** Shown when the id names nothing: a mistyped URL, or a provider since removed. */
function MissingProvider() {
  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <BackLink />
      <Card>
        <StateView
          kind="empty"
          icon={PackageX}
          title="No such provider"
          description="This provider is not in the catalog. It may have been removed, or the link may be wrong."
          action={
            <Link to="/providers" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              Back to catalog
            </Link>
          }
        />
      </Card>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div
      className="@container flex flex-col gap-5"
      role="status"
      aria-live="polite"
      aria-label="Loading provider"
    >
      <div className="flex items-start gap-3">
        <Skeleton shape="block" className="size-14" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton shape="title" className="w-48" />
          <Skeleton shape="text" className="max-w-md" />
          <Skeleton shape="text" className="w-56" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 @[520px]:grid-cols-2 @[1100px]:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index} className="flex flex-col gap-3">
            <Skeleton shape="text" className="w-20" />
            <Skeleton shape="metric" />
            <Skeleton shape="text" className="w-2/3" />
          </Card>
        ))}
      </div>

      <Card>
        <Skeleton shape="title" />
        <SkeletonText lines={4} className="mt-4" />
      </Card>

      <Card>
        <Skeleton shape="title" />
        <SkeletonText lines={5} className="mt-4" />
      </Card>
    </div>
  );
}

export function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const detail = useProviderDetail(id ?? null);
  const [importOpen, setImportOpen] = useState(false);
  const [importOpener, setImportOpener] = useState<HTMLElement | null>(null);

  // The topbar cannot know this from the path — the rail stops at Provider
  // Catalog — so the page names itself once the read lands.
  const trail = useMemo<readonly Crumb[]>(
    () => (detail.data === undefined ? [] : [{ label: detail.data.provider.name }]),
    [detail.data],
  );
  useBreadcrumbTrail(trail);

  // The route only matches with an id, but an empty one would leave the query
  // disabled — and so the page on its skeleton — forever.
  if (id === undefined || id === '') return <MissingProvider />;

  if (detail.isPending) {
    return (
      <div className="flex min-h-full flex-col gap-5 p-5">
        <BackLink />
        <DetailSkeleton />
      </div>
    );
  }

  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) return <MissingProvider />;

    return (
      <div className="flex min-h-full flex-col gap-5 p-5">
        <BackLink />
        <Card>
          <StateView
            kind="error"
            title="Could not load this provider"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={detail.isFetching}
                onClick={() => {
                  void detail.refetch();
                }}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Retry
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const { provider, models, accounts, creditPools, oauthAvailable } = detail.data;

  const openImport = () => {
    setImportOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setImportOpen(true);
  };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <DetailHeader
        provider={provider}
        actions={<DetailActions provider={provider} onImport={openImport} />}
      />

      <div className="@container flex flex-col gap-5">
        <OauthReturnNotice providerName={provider.name} />

        <CredentialNotice provider={provider} />

        <DetailStats detail={detail.data} />

        <div className="grid grid-cols-1 gap-5 @[1024px]:grid-cols-3">
          <AccountsCard
            providerId={provider.id}
            accounts={accounts}
            className="@[1024px]:col-span-2"
          />

          <div className="flex flex-col gap-5">
            <CreditPoolCard pools={creditPools} />
            {oauthAvailable ? <OauthCard provider={provider} /> : null}
          </div>
        </div>

        <ModelsCard providerId={provider.id} models={models} />

        <RoutingStrategyCard detail={detail.data} />
      </div>

      <ImportCredentialDialog
        provider={provider}
        open={importOpen}
        onOpenChange={setImportOpen}
        restoreFocusTo={importOpener}
      />
    </div>
  );
}
