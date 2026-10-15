import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { BulkResult } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/Dialog.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { useImportProxies } from '@web/hooks/use-automation.ts';
import { formatCount } from '@web/lib/format.ts';

/**
 * Paste a seller's proxy list, one line at a time.
 *
 * Partial success is the normal outcome here, not the failure case: a list of
 * two hundred lines usually has one malformed in it, and rejecting the whole
 * paste over that line would mean re-doing it by hand. So the report is per
 * line — the endpoint answers with a tally and the lines it could not read, and
 * this shows both, keeping the dialog open so the failures can be read and fixed
 * rather than vanishing with the dialog that produced them.
 *
 * The accepted shapes are spelled out above the field because they are the whole
 * contract: the scheme and the credentials are both optional, and the endpoint
 * reads a bare `host:port` as plain HTTP.
 */

export interface ImportProxyDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function ImportProxyDialog({ open, onOpenChange, restoreFocusTo }: ImportProxyDialogProps) {
  const importProxies = useImportProxies();
  const [payload, setPayload] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPayload('');
    setTouched(false);
    importProxies.reset();
  }, [open]);

  const lineCount = payload
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '').length;

  const payloadError = touched && lineCount === 0 ? 'Paste at least one proxy line.' : undefined;

  const result: BulkResult | null = importProxies.data ?? null;

  const submit = () => {
    setTouched(true);
    if (lineCount === 0) return;
    importProxies.mutate({ payload });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        {result === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Import proxies</DialogTitle>
              <DialogDescription>
                One proxy per line. Credentials are stored write-only, so this page can show that a
                proxy wants them but never what they are.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <Field
                label="Proxy list"
                required
                error={payloadError}
                hint={lineCount === 0 ? undefined : `${formatCount(lineCount)} lines`}
                description={
                  <>
                    Accepted: <code className="font-mono text-text">host:port</code>,{' '}
                    <code className="font-mono text-text">user:pass@host:port</code>, or either with a{' '}
                    <code className="font-mono text-text">http://</code>,{' '}
                    <code className="font-mono text-text">https://</code> or{' '}
                    <code className="font-mono text-text">socks5://</code> prefix. A bare address is
                    read as plain HTTP.
                  </>
                }
              >
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    rows={10}
                    spellCheck={false}
                    invalid={payloadError !== undefined}
                    className="font-mono text-xs"
                    value={payload}
                    placeholder={'203.0.113.10:8080\nsocks5://user:pass@198.51.100.7:1080'}
                    onChange={(event) => {
                      setPayload(event.target.value);
                    }}
                  />
                )}
              </Field>

              {importProxies.isError ? (
                <p
                  role="alert"
                  className="rounded-control border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger-text"
                >
                  {importProxies.error.message}
                </p>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                variant="secondary"
                disabled={importProxies.isPending}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button onClick={submit} loading={importProxies.isPending}>
                {importProxies.isPending ? 'Importing…' : 'Import'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span
                  className={
                    result.failed === 0
                      ? 'flex size-6 items-center justify-center rounded-pill border border-success/30 bg-success/12 text-success'
                      : 'flex size-6 items-center justify-center rounded-pill border border-warning/30 bg-warning/14 text-warning'
                  }
                >
                  <Check aria-hidden="true" className="size-3.5" />
                </span>
                {result.failed === 0 ? 'Proxies imported' : 'Imported with some lines skipped'}
              </DialogTitle>
              <DialogDescription>
                The pool is refreshed with what landed. Anything that failed is listed below against
                the line it came from, so it can be corrected and pasted again.
              </DialogDescription>
            </DialogHeader>

            <div
              role={result.failed > 0 ? 'alert' : 'status'}
              className="rounded-control border border-border bg-surface-2 p-2.5 text-xs text-text"
            >
              <span className="tabular-nums font-medium">
                {formatCount(result.succeeded)} of {formatCount(result.requested)}
              </span>{' '}
              {result.requested === 1 ? 'line' : 'lines'} imported.
              {result.failed === 0 ? null : (
                <span className="text-warning-text"> {formatCount(result.failed)} skipped.</span>
              )}
            </div>

            {result.errors.length === 0 ? null : (
              <ul className="scrollbar-none max-h-64 overflow-y-auto rounded-control border border-border bg-surface-2">
                {result.errors.map((failure) => (
                  <li
                    key={failure.id}
                    className="flex items-baseline gap-3 border-b border-border/50 px-3 py-2 last:border-0"
                  >
                    <span className="shrink-0 font-mono text-[0.6875rem] text-text-subtle">
                      {failure.id}
                    </span>
                    <span className="min-w-0 flex-1 text-xs text-text">{failure.message}</span>
                  </li>
                ))}
              </ul>
            )}

            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => {
                  importProxies.reset();
                  setPayload('');
                  setTouched(false);
                }}
              >
                Paste another list
              </Button>
              <Button
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
