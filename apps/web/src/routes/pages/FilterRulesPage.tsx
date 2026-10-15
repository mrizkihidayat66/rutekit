import { PageHeader } from '@web/shell/PageHeader.tsx';

import { FilterRulesPanel } from './filter-rules/FilterRulesPanel.tsx';

/**
 * Filter Rules: what the router looks for on every request, and what it does.
 *
 * This is the one Routing page that runs before the router has decided
 * anything. A mapping renames a model on its way out and a combo chooses which
 * endpoint answers; a rule here reads the request as it arrived and either stops
 * it or rewrites the part that matched, so it is the earliest thing an operator
 * can change about a request's fate.
 *
 * The page is thin on purpose — the list, its toolbar and its dialog all live in
 * `FilterRulesPanel`, which keeps the whole feature in one folder next to the
 * vocabulary it shares with its dialog.
 */
export function FilterRulesPage() {
  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Filter Rules"
        description="Patterns the router tests every request against, in order, before it reaches a provider. A rule either blocks the request or redacts what it matched."
      />

      <div className="@container">
        <FilterRulesPanel />
      </div>
    </div>
  );
}
