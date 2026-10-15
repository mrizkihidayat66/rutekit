import { Braces, Plus } from 'lucide-react';
import { useState } from 'react';

import type { ModelMappingRule, SortDirection } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { useDeleteMapping, useMappings, useUpdateMapping } from '@web/hooks/use-routing.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { ENABLED_FILTERS, type EnabledFilter } from '@web/lib/list-filters.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import {
  DEFAULT_MAPPING_DIRECTION,
  DEFAULT_MAPPING_SORT,
  MAPPING_DIRECTIONS,
  MAPPING_PAGE_SIZE,
  MAPPING_SORT_KEYS,
  isMappingDirection,
  isMappingSortKey,
  nextPriority,
  type MappingSortKey,
} from './model-mapping/mapping.ts';
import { RuleEditDialog } from './model-mapping/RuleEditDialog.tsx';
import { RulesetDialog } from './model-mapping/RulesetDialog.tsx';
import { RulesTable } from './model-mapping/RulesTable.tsx';

/**
 * Model Mapping: the rewrites applied to a model id before anything routes it.
 *
 * This is the earliest point a request can be changed, which makes the page two
 * things at once. It is a compatibility surface — a provider retires a name, and
 * rather than chase every caller, a rule renames it at the edge. And it is a
 * migration tool, which is why the whole list can be taken out as JSON, edited
 * elsewhere and put back.
 *
 * The list is read twice: once filtered, for the table the operator is looking
 * at, and once whole and in priority order, for the JSON export and for the
 * priority a new rule should start at. A new rule has to be numbered against
 * every rule that exists, not against the ones a filter happens to be showing —
 * otherwise adding a rule while searching for "gpt" would number it as though the
 * rest of the list did not exist. When the filters are the defaults the two reads
 * are the same query and collapse into one request.
 *
 * Everything that opens is component state rather than URL state: a half-filled
 * rule is not a view worth linking to, and closing a dialog should not cost a
 * history entry.
 */

export function ModelMappingPage() {
  const [search, setSearch] = useUrlText('q');
  const [enabled, setEnabled] = useUrlParam<EnabledFilter>('state', 'all', ENABLED_FILTERS);
  const [sort, setSort] = useUrlParam<MappingSortKey>(
    'sort',
    DEFAULT_MAPPING_SORT,
    MAPPING_SORT_KEYS,
  );
  const [direction, setDirection] = useUrlParam<SortDirection>(
    'direction',
    DEFAULT_MAPPING_DIRECTION,
    MAPPING_DIRECTIONS,
  );

  const [editing, setEditing] = useState<ModelMappingRule | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [rulesetOpen, setRulesetOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState<ModelMappingRule | null>(null);

  const update = useUpdateMapping();
  const remove = useDeleteMapping();

  // The whole list, unfiltered, in the order the rules actually run.
  const everything = useMappings({
    q: '',
    sort: DEFAULT_MAPPING_SORT,
    direction: DEFAULT_MAPPING_DIRECTION,
    limit: MAPPING_PAGE_SIZE,
  });
  const allRules = (everything.data?.pages ?? []).flatMap((page) => page.items);

  const rememberOpener = () => {
    setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  };

  const openNew = () => {
    rememberOpener();
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (rule: ModelMappingRule) => {
    rememberOpener();
    setEditing(rule);
    setEditorOpen(true);
  };

  const handleSortChange = (next: {
    readonly key: string | null;
    readonly direction: SortDirection;
  }) => {
    if (next.key !== null && isMappingSortKey(next.key)) setSort(next.key);
    if (isMappingDirection(next.direction)) setDirection(next.direction);
  };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Model Mapping"
        description="Rewrites applied to a model id before routing looks at it. Rules run in ascending priority and the first one that matches wins."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                rememberOpener();
                setRulesetOpen(true);
              }}
            >
              <Braces aria-hidden="true" className="size-4" />
              Ruleset
            </Button>
            <Button onClick={openNew}>
              <Plus aria-hidden="true" className="size-4" />
              New rule
            </Button>
          </>
        }
      />

      <RulesTable
        search={search}
        enabled={enabled}
        sort={sort}
        direction={direction}
        onSearchChange={setSearch}
        onEnabledChange={setEnabled}
        onClearFilters={() => {
          setSearch('');
          setEnabled('all');
        }}
        onSortChange={handleSortChange}
        onEdit={openEdit}
        onDelete={setDeleting}
        onToggleEnabled={(rule, next) => {
          update.mutate({ id: rule.id, patch: { enabled: next } });
        }}
        onNew={openNew}
      />

      <RuleEditDialog
        rule={editing}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        suggestedPriority={nextPriority(allRules)}
        restoreFocusTo={opener}
      />

      <RulesetDialog
        open={rulesetOpen}
        onOpenChange={setRulesetOpen}
        rules={allRules}
        restoreFocusTo={opener}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        destructive
        title="Delete rewrite rule"
        description={
          deleting === null
            ? ''
            : `Ids matching "${deleting.pattern}" will stop being rewritten, and whatever they name reaches routing unchanged.`
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting === null) return;
          remove.mutate(deleting.id);
        }}
      />
    </div>
  );
}
