import { Link } from 'react-router';

import type { SortDirection } from '@contracts';

import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { useProviders } from '@web/hooks/use-providers.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { BULK_PATH, JOB_PARAM } from './automation/automation.ts';
import { JobDetailDrawer } from './automation/JobDetailDrawer.tsx';
import { JobTable } from './automation/JobTable.tsx';
import {
  ANY_PROVIDER,
  DEFAULT_JOB_DIRECTION,
  DEFAULT_JOB_SORT,
  JOB_DIRECTIONS,
  JOB_SORT_KEYS,
  STATUS_FILTERS,
  isJobDirection,
  isJobSortKey,
  type JobSortKey,
  type StatusFilter,
} from './automation/logs.ts';

/**
 * Automation Logs: every import batch, and the story of each one.
 *
 * Bulk Import is where a batch is started and watched; this is where it is
 * accounted for afterwards. The two share one address for a job — the `job`
 * param — so a link to a running import opens the same view from either page,
 * and the drawer here keeps polling while it is open, which is what makes it
 * usable for a job that has not finished.
 *
 * Everything narrowing the list lives in the URL (RULESET R6.5): the search, the
 * two filters, the sort, and the job whose drawer is open. A filtered history is
 * the thing an operator pastes into a bug report, so it has to be a link.
 */

/** The catalog is a small fixed list, so it is read whole rather than paged. */
const CATALOG_QUERY = {
  q: '',
  category: null,
  status: null,
  tier: 'all',
  sort: 'name',
  direction: 'asc',
  limit: 200,
} as const;

export function AutomationLogsPage() {
  const [search, setSearch] = useUrlText('q');
  const [provider, setProvider] = useUrlParam<string>('provider', ANY_PROVIDER);
  const [status, setStatus] = useUrlParam<StatusFilter>('status', 'all', STATUS_FILTERS);
  const [sort, setSort] = useUrlParam<JobSortKey>('sort', DEFAULT_JOB_SORT, JOB_SORT_KEYS);
  const [direction, setDirection] = useUrlParam<SortDirection>(
    'direction',
    DEFAULT_JOB_DIRECTION,
    JOB_DIRECTIONS,
  );
  const [jobId, setJobId] = useUrlParam<string>(JOB_PARAM, '');

  const catalog = useProviders(CATALOG_QUERY);
  const providers = (catalog.data?.pages ?? []).flatMap((page) => page.items);

  const clearFilters = () => {
    setSearch('');
    setProvider(ANY_PROVIDER);
    setStatus('all');
  };

  const handleSortChange = (next: {
    readonly key: string | null;
    readonly direction: SortDirection;
  }) => {
    if (next.key !== null && isJobSortKey(next.key)) setSort(next.key);
    if (isJobDirection(next.direction)) setDirection(next.direction);
  };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Automation Logs"
        description="Every batch rutekit has signed in: how it ended, which credentials failed, and the step each one stopped on. Open a job to read its story."
        actions={
          <Link to={BULK_PATH} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            Start an import
          </Link>
        }
      />

      <JobTable
        search={search}
        provider={provider}
        status={status}
        sort={sort}
        direction={direction}
        providers={providers}
        activeJobId={jobId === '' ? null : jobId}
        onSearchChange={setSearch}
        onProviderChange={setProvider}
        onStatusChange={setStatus}
        onClearFilters={clearFilters}
        onSortChange={handleSortChange}
        onOpen={(job) => {
          setJobId(job.id);
        }}
      />

      <JobDetailDrawer
        jobId={jobId === '' ? null : jobId}
        providers={providers}
        onClose={() => {
          setJobId('');
        }}
      />
    </div>
  );
}
