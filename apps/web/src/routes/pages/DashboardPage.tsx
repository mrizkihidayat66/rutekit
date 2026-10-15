import { RefreshCw } from 'lucide-react';

import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton, SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useDashboard } from '@web/hooks/use-overview.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { ApiKeyPanel } from './dashboard/ApiKeyPanel.tsx';
import { EndpointsCard } from './dashboard/EndpointsCard.tsx';
import { HealthCard } from './dashboard/HealthCard.tsx';
import { LowStressToggle } from './dashboard/LowStressToggle.tsx';
import { PoolCard } from './dashboard/PoolCard.tsx';
import { QuotaPoolsCard } from './dashboard/QuotaPoolsCard.tsx';
import { RecentErrorsCard } from './dashboard/RecentErrorsCard.tsx';
import { ResourceTiles } from './dashboard/ResourceTiles.tsx';
import { TrafficCard } from './dashboard/TrafficCard.tsx';

/**
 * The Dashboard: the page the operator leaves open.
 *
 * It answers "is the router healthy and is anything broken" at a glance, so the
 * order is deliberate — resources first (the host), then the last day of
 * traffic and the health tiles, then the two things that are configured rather
 * than measured (endpoints, quota pools), then what is calling the instance
 * (API keys, the pool behind it), and finally the failures, which is the one
 * card that earns a table and a drawer on this page.
 *
 * Every card owns its own empty state, so a single missing slice never blanks
 * the page; the page-level empty only appears when there is nothing at all to
 * report — a fresh instance with no provider, no key and no traffic.
 */

function DashboardSkeleton() {
  return (
    <div
      className="@container flex flex-col gap-5"
      role="status"
      aria-live="polite"
      aria-label="Loading dashboard"
    >
      <div className="grid grid-cols-1 gap-3 @[520px]:grid-cols-2 @[900px]:grid-cols-3 @[1500px]:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Card key={index} className="flex flex-col gap-3 p-4">
            <Skeleton shape="text" className="w-16" />
            <Skeleton shape="metric" />
            <Skeleton shape="text" className="w-2/3" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-5 @[1024px]:grid-cols-3">
        <Card className="@[1024px]:col-span-2">
          <Skeleton shape="title" />
          <Skeleton shape="block" className="mt-4 h-48" />
        </Card>
        <Card>
          <Skeleton shape="title" />
          <SkeletonText lines={5} className="mt-4" />
        </Card>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const dashboard = useDashboard();

  if (dashboard.isPending) {
    return (
      <div className="flex min-h-full flex-col gap-5 p-5">
        <PageHeader title="Dashboard" description="How the router and its pool are doing right now." />
        <DashboardSkeleton />
      </div>
    );
  }

  if (dashboard.isError) {
    return (
      <div className="flex min-h-full flex-col gap-5 p-5">
        <PageHeader title="Dashboard" description="How the router and its pool are doing right now." />
        <Card>
          <StateView
            kind="error"
            title="Could not load the dashboard"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={dashboard.isFetching}
                onClick={() => {
                  void dashboard.refetch();
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

  const data = dashboard.data;
  const isEmpty =
    data.providers.total === 0 &&
    data.accounts.total === 0 &&
    data.apiKeys.length === 0 &&
    data.traffic.length === 0;

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Dashboard"
        description="How the router and its pool are doing right now."
        actions={<LowStressToggle enabled={data.status.lowStressMode} />}
      />

      {isEmpty ? (
        <Card>
          <StateView
            kind="empty"
            title="Nothing to report yet"
            description="Add a provider and create an API key, and this page will start filling in."
          />
        </Card>
      ) : (
        <div className="@container flex flex-col gap-5">
          <ResourceTiles status={data.status} />

          <div className="grid grid-cols-1 gap-5 @[1024px]:grid-cols-3">
            <TrafficCard traffic={data.traffic} className="@[1024px]:col-span-2" />
            <HealthCard tiles={data.status.health} />
          </div>

          <EndpointsCard endpoints={data.status.endpoints} />

          <div className="grid grid-cols-1 gap-5 @[1024px]:grid-cols-2">
            <QuotaPoolsCard pools={data.quotaPools} />
            <ApiKeyPanel apiKeys={data.apiKeys} />
          </div>

          <PoolCard providers={data.providers} accounts={data.accounts} />

          <RecentErrorsCard errors={data.recentErrors} />
        </div>
      )}
    </div>
  );
}
