import { Plus } from 'lucide-react';
import { useState } from 'react';

import type { ApiKey, SortDirection } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { useDeleteApiKey, useRevokeApiKey } from '@web/hooks/use-routing.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { KeyEditDialog } from './api-keys/KeyEditDialog.tsx';
import { KeyTable } from './api-keys/KeyTable.tsx';
import {
  DEFAULT_KEY_DIRECTION,
  DEFAULT_KEY_SORT,
  KEY_DIRECTIONS,
  KEY_FILTERS,
  KEY_SORT_KEYS,
  isKeyDirection,
  isKeyFilter,
  isKeySortKey,
  type KeyFilter,
  type KeySortKey,
} from './api-keys/keys.ts';

/**
 * API Keys: what clients authenticate with, and what each one is allowed to do.
 *
 * The page exists because a single shared token cannot be capped. Everything
 * here is a per-key ceiling — which models, how fast, how much, and until when —
 * so one client can be reined in without touching the others (FR-6.1–FR-6.6).
 *
 * Two of those ceilings are the reason this page is not simply a list. Expiry
 * (FR-6.3) and a tokens-per-second cap (FR-6.4) are absent from every reference
 * router, and both are the kind of limit that only works if it is visible: an
 * operator who cannot see when a key lapses will be surprised by it.
 *
 * The secret is the one thing the page cannot show twice (FR-6.7). That shapes
 * the flow rather than the layout — the create dialog stays open on a reveal
 * step until the operator closes it, because closing is what makes the secret
 * gone.
 *
 * Filters and sorting live in the URL (RULESET R6.5); which key is being edited
 * or removed is component state, since a half-open dialog is not worth linking
 * to. The state filter is answered by the endpoint — see `KeyTable` for why.
 */

type Removing =
  | { readonly kind: 'revoke'; readonly row: ApiKey }
  | { readonly kind: 'delete'; readonly row: ApiKey };

export function ApiKeysPage() {
  const [search, setSearch] = useUrlText('q');
  const [filter, setFilter] = useUrlParam<KeyFilter>('state', 'all', KEY_FILTERS);
  const [sort, setSort] = useUrlParam<KeySortKey>('sort', DEFAULT_KEY_SORT, KEY_SORT_KEYS);
  const [direction, setDirection] = useUrlParam<SortDirection>(
    'direction',
    DEFAULT_KEY_DIRECTION,
    KEY_DIRECTIONS,
  );

  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);

  const revoke = useRevokeApiKey();
  const remove = useDeleteApiKey();

  const rememberOpener = () => {
    setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  };

  const openNew = () => {
    rememberOpener();
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (key: ApiKey) => {
    rememberOpener();
    setEditing(key);
    setEditorOpen(true);
  };

  const clearFilters = () => {
    setSearch('');
    setFilter('all');
  };

  const handleSortChange = (next: {
    readonly key: string | null;
    readonly direction: SortDirection;
  }) => {
    if (next.key !== null && isKeySortKey(next.key)) setSort(next.key);
    if (isKeyDirection(next.direction)) setDirection(next.direction);
  };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="API Keys"
        description="Keys clients authenticate with. Each carries its own model scope, expiry, rate limits and budget, so one client can be capped without affecting the rest."
        actions={
          <Button onClick={openNew}>
            <Plus aria-hidden="true" className="size-4" />
            Create key
          </Button>
        }
      />

      <KeyTable
        search={search}
        filter={filter}
        sort={sort}
        direction={direction}
        onSearchChange={setSearch}
        onFilterChange={(next) => {
          if (isKeyFilter(next)) setFilter(next);
        }}
        onClearFilters={clearFilters}
        onSortChange={handleSortChange}
        onEdit={openEdit}
        onRevoke={(row) => {
          setRemoving({ kind: 'revoke', row });
        }}
        onDelete={(row) => {
          setRemoving({ kind: 'delete', row });
        }}
        onNew={openNew}
      />

      <KeyEditDialog
        apiKey={editing}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        restoreFocusTo={opener}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        destructive
        title={removing?.kind === 'revoke' ? 'Revoke key' : 'Delete key'}
        description={
          removing === null
            ? ''
            : removing.kind === 'revoke'
              ? `"${removing.row.name}" will stop authenticating immediately. The key stays in the list, marked revoked, so its usage is still accounted for — and revoking cannot be undone.`
              : `"${removing.row.name}" will be removed along with its usage record. Requests using it fail from the next one onwards.`
        }
        confirmLabel={removing?.kind === 'revoke' ? 'Revoke' : 'Delete'}
        onConfirm={() => {
          if (removing === null) return;
          if (removing.kind === 'revoke') revoke.mutate(removing.row.id);
          else remove.mutate(removing.row.id);
        }}
      />
    </div>
  );
}
