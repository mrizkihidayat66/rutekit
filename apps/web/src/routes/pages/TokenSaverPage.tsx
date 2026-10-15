import { PageHeader } from '@web/shell/PageHeader.tsx';

import { PipelineCard } from './token-saver/PipelineCard.tsx';
import { SavingsCard } from './token-saver/SavingsCard.tsx';

/**
 * Token Saver: the request-compression pipeline, and what it saves.
 *
 * This is the one Routing page that acts on the request *body* rather than on
 * where it goes. A combo picks the endpoint, a mapping renames the model, a
 * filter rule blocks or redacts a match — and everything here shrinks what is
 * left, stage by stage, before it is sent.
 *
 * The page is thin on purpose: the settings and the measurements are separate
 * reads that move at different speeds, so they live in their own cards rather
 * than behind one shared loading state.
 */
export function TokenSaverPage() {
  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Token Saver"
        description="Compress every outbound request before it reaches a provider. Five independent stages run in order, each fail-open, and the page measures what they removed."
      />

      <div className="@container flex flex-col gap-5">
        <PipelineCard />
        <SavingsCard />
      </div>
    </div>
  );
}
