import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AppError } from '@server/errors.ts';

/**
 * Where a generated file lives on disk (C10, FR-8.4).
 *
 * One directory under `RUTEKIT_DATA_DIR`, one file per asset, and the name is
 * `<asset id>.<extension>` — never anything a provider said.
 *
 * **That is a safety property, not a convention.** The obvious design stores the
 * filename the provider returned and joins it to the directory, which is how a
 * provider — or a manifest, or a model id — ends up naming a path. Here the id is
 * a UUID rutekit minted and the extension is checked against a small allowlist, so
 * there is no string from outside this process that can reach a `..` or a drive
 * letter. A provider that reports `../../etc/passwd` gets an asset whose extension
 * is refused, not a write outside the data directory.
 *
 * **The extension allowlist is a closed set.** An unknown extension is refused
 * rather than passed through: the console serves these bytes back with a content
 * type derived from the same table, so an unlisted one would either be served as
 * something it is not or as an opaque download. A media provider rutekit does not
 * understand yet is a provider whose driver does not exist yet, and the driver is
 * where a new format gets declared.
 */

/** Extension → the content type the file route answers with. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export interface StoredFile {
  readonly extension: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface AssetStorage {
  /** Write the bytes and report what they are. Refuses an unknown extension. */
  put(assetId: string, extension: string, bytes: Uint8Array): Promise<StoredFile>;
  /** The bytes, or null when the file is gone — a row whose file was deleted. */
  read(assetId: string, extension: string): Promise<Uint8Array | null>;
  /** Remove an asset's files. Missing files are not an error. */
  remove(assetId: string, extensions: readonly (string | null)[]): Promise<void>;
  /** The directory, for a log line that says where the bytes went. */
  directory(): string;
}

export interface AssetStorageDeps {
  /** `RUTEKIT_DATA_DIR`; the studio directory is created inside it. */
  readonly dataDir: string;
}

/** The content type for an extension, or null when rutekit does not serve it. */
export function mimeTypeOf(extension: string): string | null {
  return MEDIA_TYPES[extension.toLowerCase()] ?? null;
}

export function createAssetStorage(deps: AssetStorageDeps): AssetStorage {
  const root = join(deps.dataDir, 'studio');

  /**
   * The path for one asset, or a refusal.
   *
   * Both halves are checked: the id must be one rutekit could have minted, and
   * the extension must be one rutekit serves. The id check is not paranoia about
   * the database — it is what makes the path a function of two validated strings
   * rather than of whatever happened to be in the row.
   */
  function pathOf(assetId: string, extension: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(assetId)) {
      throw AppError.internal(new Error(`refusing to build a path from the asset id "${assetId}"`));
    }
    const mimeType = mimeTypeOf(extension);
    if (mimeType === null) {
      throw AppError.internal(new Error(`rutekit does not store ".${extension}" files`));
    }
    return join(root, `${assetId}.${extension.toLowerCase()}`);
  }

  return {
    async put(assetId, extension, bytes): Promise<StoredFile> {
      const path = pathOf(assetId, extension);
      const mimeType = mimeTypeOf(extension);
      // The mime type is checked by `pathOf`, so it is known here; the guard is
      // what lets the compiler see that rather than a cast.
      if (mimeType === null) throw AppError.internal(new Error('unreachable: extension was checked'));

      await mkdir(root, { recursive: true });
      await writeFile(path, bytes);
      return { extension: extension.toLowerCase(), mimeType, byteSize: bytes.byteLength };
    },

    async read(assetId, extension): Promise<Uint8Array | null> {
      const path = pathOf(assetId, extension);
      try {
        // Copied out of the Buffer rather than handed over as one. A `Buffer`
        // read off disk may be a view onto a pooled allocation shared with other
        // reads, so returning it would hand the caller bytes that another read
        // can rewrite underneath them — and the declared type says `Uint8Array`,
        // which is a promise this keeps rather than a subclass that happens to
        // satisfy it.
        return new Uint8Array(await readFile(path));
      } catch {
        // A row whose file is gone is a state a real install reaches — someone
        // cleaned the data directory, or a restore brought the database without
        // the files. Null rather than a throw, so the route can answer 404 with a
        // message about the file rather than a 500 about the read.
        return null;
      }
    },

    async remove(assetId, extensions): Promise<void> {
      for (const extension of extensions) {
        if (extension === null) continue;
        try {
          await rm(pathOf(assetId, extension), { force: true });
        } catch {
          // An extension the row no longer agrees with is a row rutekit cannot
          // build a path from; the delete already happened, and failing here
          // would leave the asset listed with no way to try again.
        }
      }
    },

    directory(): string {
      return root;
    },
  };
}
