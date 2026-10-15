import { Download, ImageOff, Star, Trash2, Wand2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { Asset } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { Drawer } from '@web/components/ui/Drawer.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { CopyButton } from '@web/components/patterns/CopyButton.tsx';
import { useDeleteStudioAsset, useStudioAsset, useUpdateStudioAsset } from '@web/hooks/use-tools.ts';
import { cn } from '@web/lib/cn.ts';
import { formatBytes, formatDateTime, formatSpan } from '@web/lib/format.ts';

import { REUSE_HINTS, REUSE_LABELS, assetTitle, parameterRows, type ReuseMode } from './studio.ts';

/**
 * One asset, at size, with everything that made it.
 *
 * The full-size view is the point of the drawer — a gallery tile is a thumbnail
 * and the question being asked here is always "is it actually good?" — so the
 * media gets the top and the metadata is the footnote beneath it.
 *
 * Video is the exception. A render's bytes are served by the backend, and until
 * it does, a `<video>` pointed at a still will not play; when that happens the
 * element is swapped for the poster rather than left showing a broken player.
 */

const REUSE_ORDER: readonly ReuseMode[] = ['refine', 'variation', 'upscale'];

export interface AssetDetailDrawerProps {
  readonly assetId: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReuse: (asset: Asset, mode: ReuseMode) => void;
  /** Follow a link to another asset (a parent) without closing the drawer. */
  readonly onNavigate: (assetId: string) => void;
}

export function AssetDetailDrawer({
  assetId,
  onOpenChange,
  onReuse,
  onNavigate,
}: AssetDetailDrawerProps) {
  const selectedId = assetId;
  const asset = useStudioAsset(selectedId);
  const remove = useDeleteStudioAsset();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const data = asset.data;

  return (
    <>
      <Drawer
        open={selectedId !== null}
        onOpenChange={onOpenChange}
        width="lg"
        title={data === undefined ? 'Asset' : assetTitle(data)}
        {...(data === undefined ? {} : { description: `${data.model} · ${data.providerId}` })}
        footer={
          data === undefined ? undefined : (
            <DrawerActions
              asset={data}
              onRequestDelete={() => {
                setConfirmDelete(true);
              }}
            />
          )
        }
      >
        {asset.isPending ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="Loading asset"
            className="flex flex-col gap-3"
          >
            <Skeleton shape="block" className="aspect-square rounded-card" />
            <Skeleton shape="text" />
            <Skeleton shape="text" />
          </div>
        ) : asset.isError ? (
          <StateView
            kind="error"
            title="Could not load this asset"
            description="The asset did not come back. It may have been deleted."
          />
        ) : data === undefined ? (
          <StateView
            kind="empty"
            title="No asset selected"
            description="Pick a tile to see it here."
          />
        ) : (
          <AssetDetailBody asset={data} onReuse={onReuse} onNavigate={onNavigate} />
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        destructive
        title="Delete this asset?"
        description="The file leaves the gallery and cannot be recovered. The generation that made it stays in the queue."
        confirmLabel="Delete asset"
        onConfirm={() => {
          if (selectedId !== null) remove.mutate(selectedId);
          onOpenChange(false);
        }}
      />
    </>
  );
}

function DrawerActions({
  asset,
  onRequestDelete,
}: {
  asset: Asset;
  onRequestDelete: () => void;
}) {
  const update = useUpdateStudioAsset();

  return (
    <div className="flex w-full items-center justify-between gap-2">
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={asset.favorite}
        onClick={() => {
          update.mutate({ id: asset.id, patch: { favorite: !asset.favorite } });
        }}
      >
        <Star
          aria-hidden="true"
          className={cn('size-3.5', asset.favorite && 'fill-current text-warning')}
        />
        {asset.favorite ? 'Starred' : 'Star'}
      </Button>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="text-danger-text" onClick={onRequestDelete}>
          <Trash2 aria-hidden="true" className="size-3.5" />
          Delete
        </Button>
        <a href={asset.url} download className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          <Download aria-hidden="true" className="size-3.5" />
          Download
        </a>
      </div>
    </div>
  );
}

function AssetDetailBody({
  asset,
  onReuse,
  onNavigate,
}: {
  asset: Asset;
  onReuse: (asset: Asset, mode: ReuseMode) => void;
  onNavigate: (assetId: string) => void;
}) {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const parentId = asset.parentAssetId;
  const rows = parameterRows(asset.parameters);

  return (
    <div className="flex flex-col gap-4">
      <AssetPreview
        asset={asset}
        playbackFailed={failedFor === asset.id}
        onPlaybackError={() => {
          setFailedFor(asset.id);
        }}
      />

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Reuse</h3>
        <div className="flex flex-wrap gap-2">
          {REUSE_ORDER.map((mode) => (
            <Button
              key={mode}
              variant="secondary"
              size="sm"
              title={REUSE_HINTS[mode]}
              onClick={() => {
                onReuse(asset, mode);
              }}
            >
              <Wand2 aria-hidden="true" className="size-3.5" />
              {REUSE_LABELS[mode]}
            </Button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Prompt</h3>
          <CopyButton value={asset.prompt} label="Copy prompt" />
        </div>
        <p className="rounded-card border border-border bg-surface-2 p-3 text-xs leading-relaxed text-text">
          {asset.prompt}
        </p>
        {asset.negativePrompt === null ? null : (
          <p className="text-xs text-text-muted">
            <span className="font-medium text-text-subtle">Negative: </span>
            {asset.negativePrompt}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Details</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-border bg-surface-2 p-3 @[420px]:grid-cols-3">
          <DetailRow label="Kind">
            <Badge tone={asset.kind === 'video' ? 'accent' : 'neutral'} size="sm">
              {asset.kind}
            </Badge>
          </DetailRow>
          <DetailRow label="Dimensions">
            {asset.width === null || asset.height === null ? '—' : `${asset.width}×${asset.height}`}
          </DetailRow>
          {asset.durationSeconds === null ? null : (
            <DetailRow label="Duration">{formatSpan(asset.durationSeconds)}</DetailRow>
          )}
          <DetailRow label="Weight">{formatBytes(asset.byteSize)}</DetailRow>
          <DetailRow label="Type">{asset.mimeType}</DetailRow>
          <DetailRow label="Created">{formatDateTime(asset.createdAt)}</DetailRow>
          {parentId === null ? null : (
            <DetailRow label="Derived from">
              <button
                type="button"
                className="font-mono text-xs text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                onClick={() => {
                  onNavigate(parentId);
                }}
              >
                {parentId}
              </button>
            </DetailRow>
          )}
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Parameters
        </h3>
        {rows.length === 0 ? (
          <p className="text-xs text-text-muted">
            This endpoint recorded no parameters for the render.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-border bg-surface-2 p-3 @[420px]:grid-cols-3">
            {rows.map((row) => (
              <DetailRow key={row.key} label={row.label}>
                <span className="font-mono tabular-nums">{row.value}</span>
              </DetailRow>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}

function AssetPreview({
  asset,
  playbackFailed,
  onPlaybackError,
}: {
  asset: Asset;
  playbackFailed: boolean;
  onPlaybackError: () => void;
}) {
  const poster = asset.thumbnailUrl;

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface-2">
      {asset.kind === 'video' && !playbackFailed ? (
        <video
          controls
          preload="metadata"
          src={asset.url}
          {...(poster === null ? {} : { poster })}
          aria-label={assetTitle(asset)}
          className="max-h-[52vh] w-full bg-black object-contain"
          onError={onPlaybackError}
        />
      ) : poster === null ? (
        <div className="flex aspect-square items-center justify-center text-text-subtle">
          <ImageOff aria-hidden="true" className="size-6" />
        </div>
      ) : (
        <img src={poster} alt={assetTitle(asset)} className="max-h-[52vh] w-full object-contain" />
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[0.6875rem] text-text-subtle">{label}</dt>
      <dd className="text-xs text-text">{children}</dd>
    </div>
  );
}
