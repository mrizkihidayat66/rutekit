import { AlertTriangle, Download, FileUp, RotateCcw } from 'lucide-react';
import { useMemo, useRef, useState, type ChangeEvent } from 'react';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '@web/components/ui/Card.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { useBackupManifest, useRestore, useStartBackup } from '@web/hooks/use-system.ts';
import { archiveFilename } from '@web/lib/download.ts';
import { formatBytes, formatCount, formatDateTime, formatRelative } from '@web/lib/format.ts';

import { SettingRow } from './SettingRow.tsx';
import { ARCHIVE_ACCEPT, base64Of } from './settings.ts';

/** A guard, not a limit the endpoint enforces — an archive this large is a mistake. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Typed by hand to arm the restore. Short, and not a word anyone types by accident. */
const CONFIRMATION = 'RESTORE';

interface Picked {
  readonly name: string;
  readonly size: number;
  readonly data: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('The file could not be read.'));
    });
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('The file could not be read.'));
    });
    reader.readAsDataURL(file);
  });
}

/**
 * Take the whole instance out as one file, or put one back.
 *
 * **The archive is the operator's file, not the server's.** Export answers with
 * the archive itself and the page hands it straight to the browser's download, so
 * what leaves the instance is a copy on the operator's disk and nothing rutekit
 * keeps. The alternative — writing it into the data directory and reporting where
 * — leaves the most sensitive file the instance can produce sitting next to the
 * database it came from, on the machine the archive is supposed to be the way
 * *out* of. The card still reports what went into it, because the point of an
 * export is knowing what you have.
 *
 * **Restore is armed rather than confirmed.** It is the one destructive action in
 * the console: the operator picks a file, then types `RESTORE`. A dialog that
 * says "are you sure" is a click; a word is a decision. Nothing is sent until
 * both are in place, and the archive's own name and size are shown back so a
 * mis-picked file is visible before it lands. What came back is reported in full
 * — tables, rows, and anything the restore refused — because a restore is the one
 * operation whose result cannot be checked by looking at the page.
 */
export function BackupTab() {
  const manifest = useBackupManifest();
  const start = useStartBackup();
  const restore = useRestore();

  const fileRef = useRef<HTMLInputElement>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [pickError, setPickError] = useState<string | null>(null);

  const armed = picked !== null && confirmation.trim() === CONFIRMATION;

  const counts = useMemo(() => {
    const entries = Object.entries(manifest.data?.tableCounts ?? {});
    return entries.sort((left, right) => right[1] - left[1]);
  }, [manifest.data]);

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Cleared so picking the same file twice still fires a change.
    event.target.value = '';
    if (file === undefined) return;
    if (file.size > MAX_ARCHIVE_BYTES) {
      setPickError(
        `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_ARCHIVE_BYTES)}.`,
      );
      return;
    }
    setPickError(null);
    void readAsDataUrl(file).then(
      (dataUrl) => {
        setPicked({ name: file.name, size: file.size, data: base64Of(dataUrl) });
        setConfirmation('');
        restore.reset();
      },
      (error: unknown) => {
        setPickError(error instanceof Error ? error.message : 'The file could not be read.');
      },
    );
  };

  return (
    <div className="@container flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Export"
          description="Download the whole instance — providers, accounts, keys, routing, history — as one archive."
        />

        <div className="mt-1 flex flex-col gap-4">
          <SettingRow
            label="Include credentials"
            description={
              includeCredentials
                ? 'Every provider key, account token and proxy password goes into the archive, still encrypted by this instance’s key. Treat the file as a secret.'
                : 'Left out. The archive restores the configuration, but every credential has to be re-entered afterwards.'
            }
            control={
              <Switch
                checked={includeCredentials}
                disabled={start.isPending}
                aria-label="Include credentials"
                onCheckedChange={setIncludeCredentials}
              />
            }
          />

          {includeCredentials ? (
            <p
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 rounded-card border border-warning/40 bg-warning/10 px-3 py-2 text-[0.6875rem] text-warning-text"
            >
              <AlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span>
                An archive with credentials is the most damaging file this instance can produce. It
                is only readable by an instance holding the same encryption key — keep it encrypted,
                and delete it when you are done.
              </span>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={start.isPending}
              disabled={start.isPending}
              onClick={() => {
                start.mutate({ includeCredentials });
              }}
            >
              <Download aria-hidden="true" className="size-3.5" />
              Download archive
            </Button>
          </div>

          <p className="text-[0.6875rem] text-text-subtle">
            The archive never carries the console password or your open sessions, whatever you
            choose here — a restore replaces how this instance is configured, not who may open it.
          </p>

          {start.isError ? (
            <p role="alert" className="text-xs text-danger-text">
              The export failed: {start.error.message}
            </p>
          ) : null}

          {start.isSuccess ? (
            <p role="status" aria-live="polite" className="text-xs text-success-text">
              Saved <span className="font-medium">{archiveFilename(start.data.createdAt)}</span> —{' '}
              {formatCount(Object.keys(start.data.tables).length)} tables
              {start.data.includesCredentials ? ', with credentials' : ', without credentials'}.
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Contents"
          description="What this instance holds right now."
          actions={
            <Button
              variant="ghost"
              size="sm"
              loading={manifest.isFetching}
              onClick={() => {
                void manifest.refetch();
              }}
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              Refresh
            </Button>
          }
        />

        <CardBody className="mt-1">
          {manifest.isPending ? (
            <SkeletonText lines={4} />
          ) : manifest.isError ? (
            <p role="alert" className="text-xs text-danger-text">
              Could not read the manifest: {manifest.error.message}
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[0.6875rem] text-text-subtle">
                <Badge tone="neutral" size="sm">
                  v{manifest.data.version}
                </Badge>
                <span>as of {formatDateTime(manifest.data.createdAt)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatRelative(manifest.data.createdAt)}</span>
              </div>

              <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 @[560px]:grid-cols-3">
                {counts.map(([table, count]) => (
                  <li key={table} className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[0.6875rem] text-text-muted">
                      {table.replace(/_/g, ' ')}
                    </span>
                    <span className="text-[0.6875rem] tabular-nums text-text">
                      {formatCount(count)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Restore"
          description="Replace everything in this instance with the contents of an archive. This cannot be undone."
        />

        <div className="mt-1 flex flex-col gap-4">
          <input
            ref={fileRef}
            type="file"
            accept={ARCHIVE_ACCEPT}
            aria-label="Backup archive"
            className="sr-only"
            onChange={onPick}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={restore.isPending}
              onClick={() => {
                fileRef.current?.click();
              }}
            >
              <FileUp aria-hidden="true" className="size-3.5" />
              Choose archive
            </Button>

            {picked === null ? (
              <span className="text-[0.6875rem] text-text-subtle">No archive chosen.</span>
            ) : (
              <span className="text-[0.6875rem] text-text-muted">
                <span className="font-medium text-text">{picked.name}</span> ·{' '}
                {formatBytes(picked.size)}
              </span>
            )}
          </div>

          {pickError === null ? null : (
            <p role="alert" className="text-xs text-danger-text">
              {pickError}
            </p>
          )}

          {picked === null ? null : (
            <Field
              label={
                <>
                  Type <span className="font-semibold text-text">{CONFIRMATION}</span> to arm the
                  restore
                </>
              }
              hint={`${confirmation.length} / ${String(CONFIRMATION.length)}`}
              description="Nothing is sent until this matches. The tables the archive names are replaced wholesale — every provider, account and key in them is overwritten."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  value={confirmation}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={CONFIRMATION}
                  disabled={restore.isPending}
                  {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                  }}
                />
              )}
            </Field>
          )}

          {restore.isError ? (
            <p role="alert" className="text-xs text-danger-text">
              The restore failed: {restore.error.message}
            </p>
          ) : null}

          {restore.isSuccess ? (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col gap-1 text-xs text-success-text"
            >
              <p>
                Restored {formatCount(restore.data.tables)} tables, {formatCount(restore.data.rows)}{' '}
                rows. Everything cached was dropped — reload the pages you were looking at.
              </p>
              {restore.data.untouched.length === 0 ? null : (
                <p className="text-text-muted">
                  Not in the archive, so left alone: {restore.data.untouched.join(', ')}.
                </p>
              )}
              {restore.data.skipped.length === 0 ? null : (
                <p className="text-warning-text">
                  Refused:{' '}
                  {restore.data.skipped
                    .map((entry) => `${entry.table} (${entry.reason})`)
                    .join(' ')}
                </p>
              )}
            </div>
          ) : null}

          <div className="flex justify-end border-t border-border pt-3">
            <Button
              variant="danger"
              size="sm"
              loading={restore.isPending}
              disabled={!armed || restore.isPending}
              onClick={() => {
                if (picked === null) return;
                restore.mutate({ archive: picked.data, confirm: true });
              }}
            >
              Restore this instance
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
