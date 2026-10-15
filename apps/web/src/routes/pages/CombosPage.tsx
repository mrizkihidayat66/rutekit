import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { Alias, Combo, SortDirection } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/Tabs.tsx';
import {
  useDeleteAlias,
  useDeleteCombo,
  useUpdateAlias,
  useUpdateCombo,
} from '@web/hooks/use-routing.ts';
import { useProviders } from '@web/hooks/use-providers.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { ENABLED_FILTERS, type EnabledFilter } from '@web/lib/list-filters.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { AliasEditDialog } from './combos/AliasEditDialog.tsx';
import { AliasTable } from './combos/AliasTable.tsx';
import { ComboEditDialog } from './combos/ComboEditDialog.tsx';
import { ComboTable } from './combos/ComboTable.tsx';
import {
  COMBO_TABS,
  COMBO_TAB_LABELS,
  DEFAULT_ROUTE_DIRECTION,
  ROUTE_DIRECTIONS,
  defaultSortForTab,
  isRouteDirection,
  isRouteSortKey,
  sortKeysForTab,
  type ComboTab,
  type RouteSortKey,
} from './combos/combos.ts';

/**
 * Combos & Routes: the names clients send, and what they resolve to.
 *
 * Both tabs answer one question — a request arrives naming a model, and
 * something has to decide what actually serves it. A combo fans one name out
 * across a chain of models; an alias collapses one name onto a single id. They
 * are the same idea at two levels of ambition, so they share a page and a
 * heading rather than getting one each.
 *
 * The two lists are different records with different fields, which is why the
 * sort vocabulary is per tab and the sort resets when the tab changes: sending
 * `name` to the alias endpoint would order by a field that does not exist. The
 * search and the enabled filter mean the same thing on both, so they are shared
 * and survive a tab switch — an operator who searched for "claude" and then
 * looked at aliases was looking for the same thing.
 *
 * Which record is being edited is component state, not URL state: a half-open
 * dialog is not a view worth linking to, and closing it should not cost a
 * history entry.
 */

type Deleting =
  { readonly kind: 'combo'; readonly row: Combo } | { readonly kind: 'alias'; readonly row: Alias };

export function CombosPage() {
  const [tab, setTab] = useUrlParam<ComboTab>('tab', 'combos', COMBO_TABS);
  const [search, setSearch] = useUrlText('q');
  const [enabled, setEnabled] = useUrlParam<EnabledFilter>('state', 'all', ENABLED_FILTERS);
  const [sort, setSort] = useUrlParam<RouteSortKey>(
    'sort',
    defaultSortForTab(tab),
    sortKeysForTab(tab),
  );
  const [direction, setDirection] = useUrlParam<SortDirection>(
    'direction',
    DEFAULT_ROUTE_DIRECTION,
    ROUTE_DIRECTIONS,
  );

  const [editingCombo, setEditingCombo] = useState<Combo | null>(null);
  const [comboOpen, setComboOpen] = useState(false);
  const [comboOpener, setComboOpener] = useState<HTMLElement | null>(null);
  const [editingAlias, setEditingAlias] = useState<Alias | null>(null);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [aliasOpener, setAliasOpener] = useState<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);

  const updateCombo = useUpdateCombo();
  const updateAlias = useUpdateAlias();
  const deleteCombo = useDeleteCombo();
  const deleteAlias = useDeleteAlias();

  // The whole catalog, for the entry and alias provider pickers. It is a small
  // fixed list, so it is fetched once, sorted by name, rather than paged.
  const catalog = useProviders({
    q: '',
    category: null,
    status: null,
    tier: 'all',
    sort: 'name',
    direction: 'asc',
    limit: 200,
  });
  const providers = (catalog.data?.pages ?? []).flatMap((page) => page.items);
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const providerOptions = useMemo(
    () => providers.map((provider) => ({ value: provider.id, label: provider.name })),
    [providers],
  );

  const isComboTab = tab === 'combos';

  const clearFilters = () => {
    setSearch('');
    setEnabled('all');
  };

  const rememberOpener = () => {
    setComboOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setAliasOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  };

  const openNew = () => {
    rememberOpener();
    if (isComboTab) {
      setEditingCombo(null);
      setComboOpen(true);
      return;
    }
    setEditingAlias(null);
    setAliasOpen(true);
  };

  const openEditCombo = (combo: Combo) => {
    rememberOpener();
    setEditingCombo(combo);
    setComboOpen(true);
  };

  const openEditAlias = (alias: Alias) => {
    rememberOpener();
    setEditingAlias(alias);
    setAliasOpen(true);
  };

  const handleSortChange = (next: {
    readonly key: string | null;
    readonly direction: SortDirection;
  }) => {
    if (next.key !== null && isRouteSortKey(next.key, tab)) setSort(next.key);
    if (isRouteDirection(next.direction)) setDirection(next.direction);
  };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Combos & Routes"
        description="One name clients send, resolved to whichever model should answer it. A combo fans out across a chain; an alias collapses onto a single model."
        actions={
          <Button onClick={openNew}>
            <Plus aria-hidden="true" className="size-4" />
            {isComboTab ? 'New combo' : 'New alias'}
          </Button>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (next === 'combos' || next === 'aliases') setTab(next);
        }}
        className="@container flex flex-col gap-4"
      >
        <TabsList aria-label="Combos or aliases">
          {COMBO_TABS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {COMBO_TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="combos">
          <ComboTable
            search={search}
            enabled={enabled}
            sort={sort}
            direction={direction}
            onSearchChange={setSearch}
            onEnabledChange={setEnabled}
            onClearFilters={clearFilters}
            onSortChange={handleSortChange}
            providerById={providerById}
            onEdit={openEditCombo}
            onDelete={(row) => {
              setDeleting({ kind: 'combo', row });
            }}
            onToggleEnabled={(row, next) => {
              updateCombo.mutate({ id: row.id, patch: { enabled: next } });
            }}
            onNew={openNew}
          />
        </TabsContent>

        <TabsContent value="aliases">
          <AliasTable
            search={search}
            enabled={enabled}
            sort={sort}
            direction={direction}
            onSearchChange={setSearch}
            onEnabledChange={setEnabled}
            onClearFilters={clearFilters}
            onSortChange={handleSortChange}
            providerById={providerById}
            onEdit={openEditAlias}
            onDelete={(row) => {
              setDeleting({ kind: 'alias', row });
            }}
            onToggleEnabled={(row, next) => {
              updateAlias.mutate({ id: row.id, patch: { enabled: next } });
            }}
            onNew={openNew}
          />
        </TabsContent>
      </Tabs>

      <ComboEditDialog
        combo={editingCombo}
        open={comboOpen}
        onOpenChange={setComboOpen}
        providerOptions={providerOptions}
        restoreFocusTo={comboOpener}
      />

      <AliasEditDialog
        alias={editingAlias}
        open={aliasOpen}
        onOpenChange={setAliasOpen}
        providerOptions={providerOptions}
        restoreFocusTo={aliasOpener}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        destructive
        title={deleting?.kind === 'alias' ? 'Delete alias' : 'Delete combo'}
        description={
          deleting === null
            ? ''
            : deleting.kind === 'alias'
              ? `Clients sending "${deleting.row.alias}" will stop resolving, and the request fails unless another rule catches it.`
              : `Clients sending "${deleting.row.name}" will stop resolving. The chain itself is removed.`
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting === null) return;
          if (deleting.kind === 'combo') deleteCombo.mutate(deleting.row.id);
          else deleteAlias.mutate(deleting.row.id);
        }}
      />
    </div>
  );
}
