import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import type { JobInput } from '@contracts';

import type { JobAction } from '@web/components/patterns/job-vocabulary.ts';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import {
  useCreateJob,
  useJob,
  useJobControl,
  useProxies,
  useSmsProviders,
  useSubmitJobManual,
} from '@web/hooks/use-automation.ts';
import { useUrlParam } from '@web/hooks/use-url-state.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { JobLauncherForm } from './automation/JobLauncherForm.tsx';
import { JobPanel, JobPanelPending } from './automation/JobPanel.tsx';
import { JOB_PARAM, LOGS_PATH } from './automation/automation.ts';

/**
 * Automation: hand rutekit a list of credentials, tokens, or a request to
 * register, and watch it work.
 *
 * The page is two halves that share one piece of state — the job in the URL. The
 * launcher on the left decides what to run; the panel on the right watches
 * whichever job the operator is looking at. The job id lives in the URL so a
 * running import is a link: an operator who starts a batch on their laptop and
 * pastes the address into chat has handed a colleague the same live view, with
 * the same poll attached.
 *
 * The two pools the launcher reads — proxies and SMS keys — are pickers rather
 * than tables, so both are fetched as one large page. A pool big enough to need
 * paging is big enough that a picker is the wrong control for it, and the pages
 * that own those pools already exist for that job.
 *
 * Nothing here owns the job's progress. The backend does; the panel only reads,
 * and the poll stops on its own once the job stops moving.
 */

/** The picker lists, read whole: a pool that needs paging needs its own page. */
const PICKER_QUERY = {
  q: '',
  sort: null,
  direction: 'asc',
  limit: 200,
} as const;

function NoJobPanel() {
  return (
    <Card>
      <StateView
        kind="empty"
        title="Nothing is running"
        description="Start a run on the left, or open the history to watch a job that is already going."
        action={
          <Link to={LOGS_PATH} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            Open job history
          </Link>
        }
      />
    </Card>
  );
}

export function AutomationPage() {
  const [jobId, setJobId] = useUrlParam<string>(JOB_PARAM, '');
  const [resetKey, setResetKey] = useState(0);

  const proxyPool = useProxies({ ...PICKER_QUERY, protocol: null, health: null });
  const smsPool = useSmsProviders({ ...PICKER_QUERY, kind: null, status: null });

  const proxies = (proxyPool.data?.pages ?? []).flatMap((page) => page.items);
  const smsProviders = (smsPool.data?.pages ?? []).flatMap((page) => page.items);

  const create = useCreateJob();
  const job = useJob(jobId === '' ? null : jobId);
  const control = useJobControl(jobId);
  const manual = useSubmitJobManual(jobId);

  const startRun = (input: JobInput) => {
    create.mutate(input, {
      onSuccess: (created) => {
        setJobId(created.id);
        setResetKey((count) => count + 1);
      },
    });
  };

  const runControl = (action: JobAction) => {
    control.mutate({ action });
  };

  const sendManual = (itemId: string, solution: string) => {
    manual.mutate({ itemId, solution });
  };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Automation"
        description="Sign a batch of credentials in, import tokens that were issued elsewhere, or register accounts from scratch — inside a real browser, pausing for a human whenever a challenge appears."
        actions={
          <Link to={LOGS_PATH} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            Job history
          </Link>
        }
      />

      <div className="@container">
        <div className="grid grid-cols-1 items-start gap-5 @[1100px]:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <JobLauncherForm
            proxies={proxies}
            proxiesLoading={proxyPool.isPending}
            smsProviders={smsProviders}
            smsLoading={smsPool.isPending}
            submitting={create.isPending}
            error={create.error === null ? null : create.error.message}
            resetKey={resetKey}
            onSubmit={startRun}
          />

          <div className="flex min-w-0 flex-col gap-4">
            {jobId === '' ? (
              <NoJobPanel />
            ) : job.isPending ? (
              <JobPanelPending />
            ) : job.isError ? (
              <Card>
                <StateView
                  kind="error"
                  title="Could not load this job"
                  description="The console API did not answer. It may have been cleared, or the server may be down."
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={job.isFetching}
                      onClick={() => {
                        void job.refetch();
                      }}
                    >
                      <RefreshCw aria-hidden="true" className="size-3.5" />
                      Retry
                    </Button>
                  }
                />
              </Card>
            ) : job.data === undefined ? null : (
              <JobPanel
                job={job.data}
                controlling={control.isPending}
                controlError={control.error === null ? null : control.error.message}
                onControl={runControl}
                manualSubmitting={manual.isPending}
                manualError={manual.error === null ? null : manual.error.message}
                onSubmitManual={sendManual}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
