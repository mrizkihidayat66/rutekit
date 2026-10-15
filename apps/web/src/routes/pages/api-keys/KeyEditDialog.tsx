import { useEffect, useState } from 'react';

import type { ApiKey } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/Dialog.tsx';
import { useCreateApiKey, useUpdateApiKey } from '@web/hooks/use-routing.ts';

import { KeyForm } from './KeyForm.tsx';
import { SecretReveal } from './SecretReveal.tsx';
import {
  EMPTY_KEY_DRAFT,
  draftFromKey,
  inputFromDraft,
  scopeClash,
  type KeyDraft,
} from './keys.ts';

/**
 * Create or edit one API key, then hand over its secret.
 *
 * Creating a key is two steps in one dialog rather than two dialogs, because the
 * second step is not a decision — it is the only chance to read the secret. A
 * second dialog would put a "next" in front of something the operator has to do
 * anyway, and would leave a window in which the secret is in memory but not on
 * screen.
 *
 * The step is local state, and it resets whenever the dialog opens. Closing is
 * therefore what ends the reveal, which is what makes "shown once" true rather
 * than merely intended.
 */

export interface KeyEditDialogProps {
  readonly apiKey: ApiKey | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly restoreFocusTo?: HTMLElement | null | undefined;
}

export function KeyEditDialog({ apiKey, open, onOpenChange, restoreFocusTo }: KeyEditDialogProps) {
  const create = useCreateApiKey();
  const update = useUpdateApiKey();
  const [draft, setDraft] = useState<KeyDraft>(EMPTY_KEY_DRAFT);
  const [touched, setTouched] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(apiKey === null ? EMPTY_KEY_DRAFT : draftFromKey(apiKey));
    setTouched(false);
    setSecret(null);
    create.reset();
    update.reset();
  }, [open, apiKey]);

  // Recomputed each render so a preset reads as the date it will resolve to.
  const now = new Date();
  const clash = touched ? scopeClash(draft) : undefined;
  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;

  const close = () => {
    onOpenChange(false);
  };

  const submit = () => {
    setTouched(true);
    const input = inputFromDraft(draft, now, apiKey);
    if (input === undefined) return;
    if (apiKey === null) {
      create.mutate(input, {
        onSuccess: (created) => {
          setSecret(created.secret);
        },
      });
      return;
    }
    update.mutate({ id: apiKey.id, patch: input }, { onSuccess: close });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        restoreFocusTo={restoreFocusTo}
      >
        {secret === null ? (
          <>
            <DialogHeader>
              <DialogTitle>{apiKey === null ? 'New API key' : 'Edit API key'}</DialogTitle>
              <DialogDescription>
                Every limit below belongs to this key alone. Leave a limit empty for no ceiling at
                all.
              </DialogDescription>
            </DialogHeader>

            <KeyForm
              draft={draft}
              onDraftChange={(update) => {
                setDraft(update);
              }}
              touched={touched}
              now={now}
              clash={clash}
              failure={failure}
            />

            <DialogFooter>
              <Button variant="secondary" disabled={pending} onClick={close}>
                Cancel
              </Button>
              <Button onClick={submit} loading={pending}>
                {apiKey === null ? 'Create key' : 'Save changes'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Copy the secret now</DialogTitle>
              <DialogDescription>
                This is the only time the secret is shown. The console keeps a hash of it, so if it
                is lost the key has to be replaced.
              </DialogDescription>
            </DialogHeader>

            <SecretReveal
              name={apiKey === null ? draft.name.trim() : apiKey.name}
              secret={secret}
            />

            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
