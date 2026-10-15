import type {
  Asset,
  GenerationJob,
  StudioAssetsQuery,
  StudioAssetsResponse,
  StudioGenerationsQuery,
  StudioGenerationsResponse,
} from '@contracts';
import {
  assetSchema,
  consolePath,
  consolePaths,
  generationJobSchema,
} from '@contracts';
import { AppError } from '@server/errors.ts';
import type { StudioAssetRow, StudioGenerationRow, StudioRepository } from '@server/persistence/studio.ts';
import { mimeTypeOf, type AssetStorage } from '@server/studio/storage.ts';

/**
 * The Studio's read models (C10, FR-8.3–8.6).
 *
 * A stored row as the contract reads it, and the two listings the console pages
 * through. Both are small, and both are worth explaining in the same place.
 *
 * **The asset's `url` is built, not stored.** It is a console path derived from
 * the id, so it cannot drift from the route that serves the bytes, and a change
 * to the route is one edit rather than a migration. Nothing in the row knows
 * what a URL looks like, which is also what keeps a stored asset independent of
 * where the console is mounted.
 *
 * **`thumbnailUrl` is null, always, for now.** The contract allows it and the
 * gallery falls back to `url` — so a grid tile loads the full image, which is
 * correct and a little heavier than it needs to be. Producing a real thumbnail
 * means decoding and re-encoding an image, which is a dependency rutekit does not
 * have and should not acquire silently for a gallery. A driver that already has a
 * preview (a video renderer that writes a poster frame) is where one would come
 * from, and `studio_assets.thumbnail_extension` is the column waiting for it.
 *
 * **A row that does not parse is an error, not a gap.** Every column here is
 * written by rutekit from contract-validated input, so a row the schema rejects
 * means the database was edited outside the process. Dropping it from a listing
 * would hide the one thing an operator needs to find; failing names it.
 */

export interface StudioCatalog {
  listAssets(query: StudioAssetsQuery): StudioAssetsResponse;
  getAsset(id: string): Asset;
  listGenerations(query: StudioGenerationsQuery): StudioGenerationsResponse;
  getGeneration(id: string): GenerationJob;
  /** The bytes of an asset's file, and what to serve them as. */
  file(id: string): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }>;
  /** Delete an asset and the files behind it. */
  removeAsset(id: string): Promise<void>;
  setFavorite(id: string, favorite: boolean): Asset;
}

export interface StudioCatalogDeps {
  readonly studio: StudioRepository;
  readonly storage: AssetStorage;
}

/** One stored render as the contract reads it. */
export function toGenerationJob(row: StudioGenerationRow): GenerationJob {
  return generationJobSchema.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    providerId: row.providerId,
    model: row.model,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt,
    progress: row.progress,
    stage: row.stage,
    assetId: row.assetId,
    error: row.error,
    parameters: row.parameters,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
}

/** One stored file as the contract reads it. */
export function toAsset(row: StudioAssetRow): Asset {
  return assetSchema.parse({
    id: row.id,
    kind: row.kind,
    url: consolePath(consolePaths.studioAssetFile, { id: row.id }),
    // Always null, and the reason is a route rather than a renderer: the file
    // path serves the asset's own bytes, so a thumbnail would need a second way
    // in — a query on this path, or one of its own. Returning the same URL here
    // would tell the gallery a preview exists and hand it the full file, which
    // is worse than saying there is none. See the note at the top of this file.
    thumbnailUrl: null,
    width: row.width,
    height: row.height,
    durationSeconds: row.durationSeconds,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    providerId: row.providerId,
    model: row.model,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt,
    parameters: row.parameters,
    parentAssetId: row.parentAssetId,
    favorite: row.favorite,
    createdAt: row.createdAt,
  });
}

export function createStudioCatalog(deps: StudioCatalogDeps): StudioCatalog {
  function requireAsset(id: string): StudioAssetRow {
    const row = deps.studio.findAsset(id);
    if (row === null) throw AppError.notFound(`No asset with id ${id}.`);
    return row;
  }

  function requireGeneration(id: string): StudioGenerationRow {
    const row = deps.studio.findGeneration(id);
    if (row === null) throw AppError.notFound(`No generation with id ${id}.`);
    return row;
  }

  return {
    listAssets(query: StudioAssetsQuery): StudioAssetsResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.studio.listAssets();
      if (query.kind !== null) rows = rows.filter((row) => row.kind === query.kind);
      if (query.favorite) rows = rows.filter((row) => row.favorite);
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.prompt, row.model, row.providerId, row.id].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        );
      }
      return page(rows.map(toAsset), query);
    },

    getAsset(id: string): Asset {
      return toAsset(requireAsset(id));
    },

    listGenerations(query: StudioGenerationsQuery): StudioGenerationsResponse {
      let rows = deps.studio.listGenerations();
      if (query.kind !== null) rows = rows.filter((row) => row.kind === query.kind);
      if (query.status !== null) rows = rows.filter((row) => row.status === query.status);
      return page(rows.map(toGenerationJob), query);
    },

    getGeneration(id: string): GenerationJob {
      return toGenerationJob(requireGeneration(id));
    },

    async file(id: string) {
      const row = requireAsset(id);
      const bytes = await deps.storage.read(row.id, row.extension);
      if (bytes === null) {
        // The row survived and the file did not — a data directory that was
        // cleaned, or a restore that brought the database without the bytes.
        // Saying which half is missing is the difference between an operator
        // who knows what happened and one who thinks rutekit lost their work.
        throw AppError.notFound(
          `The file behind asset ${id} is missing from the data directory.`,
        );
      }
      // The mime type is read off the extension rather than off the row, so the
      // two can never disagree about what is being served.
      return { bytes, mimeType: mimeTypeOf(row.extension) ?? row.mimeType };
    },

    async removeAsset(id: string): Promise<void> {
      const row = requireAsset(id);
      // The row first: a delete that fails after the file is gone leaves an asset
      // listed with no bytes, while the reverse leaves a file nothing points at.
      // The first is visible; the second is an orphan only a sweep would find.
      deps.studio.deleteAsset(id);
      await deps.storage.remove(row.id, [row.extension, row.thumbnailExtension]);
    },

    setFavorite(id: string, favorite: boolean): Asset {
      requireAsset(id);
      deps.studio.setFavorite(id, favorite);
      return toAsset(requireAsset(id));
    },
  };
}

/**
 * One page of a listing.
 *
 * Cursors are plain offsets, matching what the console's pager sends. Sorting is
 * left to the repository when the query names nothing rutekit knows: newest-first
 * is what both of these lists are read for, and replacing it with an arbitrary
 * column would make the first render disagree with the order that matters.
 */
function page<TItem extends SortableItem>(
  items: readonly TItem[],
  query: { readonly cursor: string | null; readonly limit: number; readonly sort: string | null; readonly direction: 'asc' | 'desc' },
): { items: TItem[]; nextCursor: string | null; total: number } {
  const sorted = sortRows(items, query);
  const offset = offsetOf(query.cursor);
  const next = offset + query.limit;
  return {
    items: sorted.slice(offset, next),
    nextCursor: next < sorted.length ? String(next) : null,
    total: sorted.length,
  };
}

type SortableItem = Asset | GenerationJob;

function sortRows<TItem extends SortableItem>(
  items: readonly TItem[],
  query: { readonly sort: string | null; readonly direction: 'asc' | 'desc' },
): TItem[] {
  const sorters: Readonly<Record<string, (item: TItem) => string | number>> = {
    createdAt: (item) => item.createdAt,
    // The prompt is what an operator scans by when they are looking for a
    // particular render among many.
    prompt: (item) => item.prompt,
    model: (item) => item.model,
    providerId: (item) => item.providerId,
  };
  const sorter = sorters[query.sort ?? ''];
  if (sorter === undefined) return [...items];

  const direction = query.direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const left = sorter(a);
    const right = sorter(b);
    if (left === right) return a.id.localeCompare(b.id);
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return order * direction;
  });
}

function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
