/**
 * Hand a generated file to the browser to save.
 *
 * A generated file is assembled in the page — a CSV of a usage table, an exported
 * archive — and the browser's own download is what puts it on disk. The object
 * URL is revoked on a later task rather than straight away: Chrome reads the blob
 * after the click handler has returned, and revoking inside the same task leaves
 * it with nothing to read.
 */
export function downloadText(filename: string, mimeType: string, text: string): void {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * What an exported archive is called on disk.
 *
 * The server names it in `content-disposition` for a client that navigates to the
 * export route; the console reads the body and saves it itself, so it names the
 * file here too — and both derive the name from the archive's own `createdAt`, so
 * the two agree without a second source of truth. The date belongs in the name
 * because the point of an export is that it is a copy taken at a moment: a
 * directory of `rutekit-backup.json` files says nothing about which is which.
 */
export function archiveFilename(createdAt: string): string {
  return `rutekit-backup-${createdAt.slice(0, 10)}.json`;
}
