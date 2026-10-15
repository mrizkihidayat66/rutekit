import { Play, Star } from 'lucide-react';

import type { Asset, AssetKind } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useStudioAssets, useUpdateStudioAsset } from '@web/hooks/use-tools.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatSpan } from '@web/lib/format.ts';

import { GALLERY_PAGE, assetMeta, assetTitle } from './studio.ts';

/**
 * The gallery: everything the Studio has already made, newest first.
 *
 * A grid of tiles rather than a table, because the thing being listed is the
 * picture. Each tile is a button that opens the detail view, and the star is a
 * separate button beside it — nesting one inside the other would be a button in
 * a button, which is not markup a browser will honour.
 */

const GRID =
  'grid grid-cols-2 gap-3 @[520px]:grid-cols-3 @[820px]:grid-cols-4 @[1180px]:grid-cols-5';

const SKELETON_TILES = 10;

export interface StudioGalleryProps {
  readonly kind: AssetKind;
  readonly starred: boolean;
  readonly search: string;
  readonly onOpen: (assetId: string) => void;
}

export function StudioGallery({ kind, starred, search, onOpen }: StudioGalleryProps) {
  const assets = useStudioAssets({
    kind,
    favorite: starred,
    q: search,
    sort: null,
    direction: 'desc',
    limit: GALLERY_PAGE,
  });

  const rows = (assets.data?.pages ?? []).flatMap((page) => page.items);
  const total = assets.data?.pages[0]?.total ?? null;
  const narrowed = starred || search.trim() !== '';

  if (assets.isPending) {
    return (
      <div role="status" aria-live="polite" aria-label="Loading assets" className={GRID}>
        {Array.from({ length: SKELETON_TILES }, (_, index) => (
          <Skeleton key={index} shape="block" className="aspect-square rounded-card" />
        ))}
      </div>
    );
  }

  if (assets.isError) {
    return (
      <Card>
        <StateView
          kind="error"
          title="Could not load the gallery"
          description="The asset list did not come back. Retrying may help."
          action={
            <Button
              variant="secondary"
              size="sm"
              loading={assets.isFetching}
              onClick={() => {
                void assets.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <StateView
          kind={narrowed ? 'no-results' : 'empty'}
          title={narrowed ? 'Nothing matches' : `No ${kind}s yet`}
          description={
            narrowed
              ? 'No asset matches this filter. Clear it, or try another search.'
              : 'Write a prompt above and generate — everything you make lands here.'
          }
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className={GRID}>
        {rows.map((asset) => (
          <li key={asset.id} className="flex">
            <GalleryTile asset={asset} onOpen={onOpen} />
          </li>
        ))}
      </ul>

      {assets.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            loading={assets.isFetchingNextPage}
            onClick={() => {
              void assets.fetchNextPage();
            }}
          >
            Load more
            <span className="tabular-nums text-text-muted">
              ({formatCount(rows.length)} of {formatCount(total ?? rows.length)})
            </span>
          </Button>
        </div>
      ) : (
        <p className="text-center text-xs tabular-nums text-text-subtle">
          {formatCount(rows.length)} of {formatCount(total ?? rows.length)} assets
        </p>
      )}
    </div>
  );
}

function GalleryTile({ asset, onOpen }: { asset: Asset; onOpen: (id: string) => void }) {
  const update = useUpdateStudioAsset();
  const preview = asset.thumbnailUrl ?? asset.url;

  return (
    <div
      className={cn(
        'group flex w-full flex-col overflow-hidden rounded-card border border-border bg-surface-1',
        'transition duration-(--dur-micro) ease-out hover:border-border-strong',
      )}
    >
      <button
        type="button"
        onClick={() => {
          onOpen(asset.id);
        }}
        aria-label={`Open ${assetTitle(asset)}`}
        className="relative aspect-square w-full overflow-hidden bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
      >
        <img
          src={preview}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover transition duration-(--dur-macro) ease-out group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />


        {asset.kind === 'video' ? (
          <span className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded-pill bg-scrim px-2 py-0.5 text-[0.625rem] font-medium text-white backdrop-blur-[2px]">
            <Play aria-hidden="true" className="size-3 fill-current" />
            {asset.durationSeconds === null ? 'Video' : formatSpan(asset.durationSeconds)}
          </span>
        ) : null}
      </button>

      <div className="flex items-start gap-1 p-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-text" title={asset.prompt}>
            {assetTitle(asset)}
          </p>
          <p className="truncate text-[0.6875rem] tabular-nums text-text-subtle">
            {assetMeta(asset)}
          </p>
        </div>
        <button
          type="button"
          aria-label={asset.favorite ? 'Remove from starred' : 'Add to starred'}
          aria-pressed={asset.favorite}
          disabled={update.isPending}
          onClick={() => {
            update.mutate({ id: asset.id, patch: { favorite: !asset.favorite } });
          }}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-control outline-none',
            'transition duration-(--dur-fast) ease-out hover:bg-surface-2',
            'focus-visible:ring-2 focus-visible:ring-focus',
            asset.favorite ? 'text-warning' : 'text-text-subtle',
          )}
        >
          <Star
            aria-hidden="true"
            className={cn('size-3.5', asset.favorite && 'fill-current')}
          />
        </button>
      </div>
    </div>
  );
}
