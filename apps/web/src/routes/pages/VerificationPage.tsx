import { ScanSearch } from 'lucide-react';

import { Button } from '@web/components/ui/Button.tsx';
import { useUrlFlag, useUrlParam } from '@web/hooks/use-url-state.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { VerificationDetail } from './verification/VerificationDetail.tsx';
import { VerificationHistory } from './verification/VerificationHistory.tsx';
import { VerificationLauncher } from './verification/VerificationLauncher.tsx';
import { LAUNCH_PARAM, RESULT_PARAM } from './verification/verification.ts';

/**
 * Model Verification.
 *
 * The question "is this endpoint really the model it says it is" is answered by
 * behaviour, so the page is two panes: the history on the left and one result on
 * the right. The launcher takes the right pane rather than opening over the top,
 * because the run being written is usually a follow-up to the one on screen.
 *
 * Both the open result and the launcher live in the URL, so a finding is a link
 * and the back button closes the launcher.
 */
export function VerificationPage() {
  const [resultParam, setResultParam] = useUrlParam<string>(RESULT_PARAM, '');
  const [launching, setLaunching] = useUrlFlag(LAUNCH_PARAM, false);

  const openResult = (id: string): void => {
    setLaunching(false);
    setResultParam(id);
  };

  const startLaunching = (): void => {
    setResultParam('');
    setLaunching(true);
  };

  return (
    <div className="@container flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Model Verification"
        description="Ask what an endpoint really is by how it behaves — probe its tokenizer, its API surface and its own consistency, then read where the evidence lands. The answer is always a band, never a yes or a no."
        actions={
          <Button variant="secondary" size="sm" onClick={startLaunching} disabled={launching}>
            <ScanSearch aria-hidden="true" className="size-3.5" />
            New verification
          </Button>
        }
      />

      <div className="flex flex-col gap-4 @[1000px]:flex-row @[1000px]:items-start">
        <div className="@[1000px]:w-72 @[1000px]:shrink-0">
          <VerificationHistory
            selectedId={launching ? '' : resultParam}
            onSelect={openResult}
            onNew={startLaunching}
          />
        </div>

        <div className="min-w-0 flex-1">
          {launching ? (
            <VerificationLauncher
              onCreated={openResult}
              onCancel={() => {
                setLaunching(false);
              }}
            />
          ) : (
            <VerificationDetail resultId={resultParam === '' ? null : resultParam} />
          )}
        </div>
      </div>
    </div>
  );
}
