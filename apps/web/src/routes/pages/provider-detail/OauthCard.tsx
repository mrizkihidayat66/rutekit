import { ExternalLink, LogIn, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import type { Provider } from '@contracts';

import { CopyButton } from '@web/components/patterns/CopyButton.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/Dialog.tsx';
import { useStartProviderOauth } from '@web/hooks/use-providers.ts';
import { cn } from '@web/lib/cn.ts';

/**
 * The sign-in, for the providers that issue credentials through a consent step
 * rather than a key the operator pastes.
 *
 * Two shapes reach this one dialog and it does not need to tell them apart. A
 * browser flow hands back the consent URL; a device flow hands back the
 * verification URI and puts the user code in the sentence beside it. Both arrive
 * as the same result — a URL to open and a line explaining what to do there — so
 * the dialog renders the message, offers the link, and waits, which is correct
 * for either without a flag saying which it is.
 *
 * The consent happens off-site, in a tab rutekit does not control, so there is
 * nothing to complete here: the flow runs on the server, and this dialog only
 * reports that it started and how to finish it. The credential lands in the
 * provider's accounts on its own, which is why the card is a launcher and not a
 * form.
 */

export interface OauthCardProps {
  readonly provider: Provider;
  readonly className?: string;
}

export function OauthCard({ provider, className }: OauthCardProps) {
  const oauth = useStartProviderOauth(provider.id);
  const [open, setOpen] = useState(false);

  const start = () => {
    oauth.reset();
    setOpen(true);
    oauth.mutate();
  };

  const close = () => {
    setOpen(false);
    oauth.reset();
  };

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader
        title="Sign in"
        description={`${provider.name} issues credentials through a consent step rather than an API key.`}
      />

      <div className="flex flex-col gap-3">
        <p className="flex items-start gap-2 text-xs text-text-muted">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-subtle" />
          rutekit starts the flow on its own machine and keeps the resulting token write-only, the
          same as an imported credential. Nothing here sees the token itself.
        </p>

        <div>
          <Button
            variant="secondary"
            onClick={() => {
              start();
            }}
          >
            <LogIn aria-hidden="true" className="size-4" />
            Sign in to {provider.name}
          </Button>
        </div>
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Sign in to {provider.name}</DialogTitle>
            <DialogDescription>
              The sign-in happens off-site. Finish it in the tab rutekit opens; the new credential
              appears on this page by itself.
            </DialogDescription>
          </DialogHeader>

          <OauthDialogBody
            pending={oauth.isPending}
            message={oauth.data?.message}
            authorizeUrl={oauth.data?.authorizeUrl ?? null}
            error={oauth.isError ? oauth.error.message : null}
          />

          <DialogFooter>
            <DialogClose asChild>
              <button
                type="button"
                className="h-9 rounded-control border border-border bg-surface-2 px-3.5 text-sm font-medium text-text transition duration-(--dur-micro) ease-out hover:bg-surface-3"
              >
                Close
              </button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface OauthDialogBodyProps {
  readonly pending: boolean;
  readonly message: string | undefined;
  readonly authorizeUrl: string | null;
  readonly error: string | null;
}

function OauthDialogBody({ pending, message, authorizeUrl, error }: OauthDialogBodyProps) {
  if (pending) {
    return (
      <p role="status" aria-live="polite" className="text-xs text-text-muted">
        Starting the sign-in…
      </p>
    );
  }

  if (error !== null) {
    return (
      <p role="alert" className="text-xs text-danger-text">
        {error}
      </p>
    );
  }

  if (message === undefined) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2 rounded-control border border-border bg-surface-2 p-3">
        <p className="text-xs text-text-muted">{message}</p>
        <CopyButton value={message} label="sign-in details" iconOnly />
      </div>

      {authorizeUrl === null ? null : (
        <a
          href={authorizeUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1 rounded-control text-sm text-accent outline-none transition duration-(--dur-micro) ease-out hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          Open the sign-in page
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      )}

      <p className="text-xs text-text-subtle">
        Waiting — you can close this once the provider confirms. rutekit keeps the flow going on its
        own.
      </p>
    </div>
  );
}
