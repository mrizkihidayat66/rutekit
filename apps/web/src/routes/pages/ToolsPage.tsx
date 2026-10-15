import type { ReactNode } from 'react';

import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { useUrlParam } from '@web/hooks/use-url-state.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { DotTrickPanel } from './tools/DotTrickPanel.tsx';
import { VccPanel } from './tools/VccPanel.tsx';
import {
  DEFAULT_SECTION,
  SECTIONS,
  SECTION_LABELS,
  SECTION_PARAM,
  type ToolsSection,
} from './tools/tools.ts';

/**
 * Tools: the two things that are neither a catalog nor a pipeline.
 *
 * They are gathered here because each is a small job an operator does by hand
 * rather than a list the router reads — expanding an address into its variants,
 * minting the cards a sign-up can pay with — and neither is large enough to
 * deserve a page of its own. Which one is open lives in the URL, so a link can
 * point at one of them rather than at the page they happen to be filed under.
 *
 * Filter rules used to be the third section here and moved under Routing: a rule
 * is not a job somebody runs, it is something every request passes through.
 */

const SECTION_OPTIONS = SECTIONS.map((value) => ({ value, label: SECTION_LABELS[value] }));

function renderPanel(section: ToolsSection): ReactNode {
  switch (section) {
    case 'dot-trick':
      return <DotTrickPanel />;
    case 'vcc':
      return <VccPanel />;
  }
}

export function ToolsPage() {
  const [section, setSection] = useUrlParam<ToolsSection>(
    SECTION_PARAM,
    DEFAULT_SECTION,
    SECTIONS,
  );

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Tools"
        description="Small jobs done by hand: expanding one address into the spellings a provider treats as separate, and keeping the pool of cards a sign-up can pay with."
        actions={
          <SegmentedControl
            aria-label="Tool"
            value={section}
            onValueChange={setSection}
            options={SECTION_OPTIONS}
          />
        }
      />

      <div className="@container">{renderPanel(section)}</div>
    </div>
  );
}
