import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps
  extends ComponentPropsWithRef<typeof DialogPrimitive.Content> {
  /** Hides the built-in close affordance for flows that must be resolved. */
  hideClose?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /**
   * Where focus should land when the dialog closes.
   *
   * Radix restores focus to its own `DialogTrigger`, but a dialog whose trigger
   * lives in another component (a page header, a toolbar) has no trigger to
   * find, and falls back to `document.body` — which drops a keyboard user at the
   * top of the page. Passing the invoking control here keeps them where they
   * were (RULESET R4.9).
   */
  restoreFocusTo?: HTMLElement | null | undefined;
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
} as const;

/**
 * Radix owns focus trapping, scroll locking, Escape and focus restore here —
 * it is the well-tested implementation, and `@radix-ui/react-presence` keeps
 * the node mounted while the exit animation runs. It marks the background inert
 * by setting `aria-hidden` on the page's other children, so unlike the
 * hand-rolled Drawer it has no need for `aria-modal` on the content itself.
 */
export function DialogContent({
  className,
  children,
  hideClose = false,
  size = 'md',
  restoreFocusTo,
  onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-dialog bg-scrim backdrop-blur-[2px]',
          'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-in',
        )}
      />
      <DialogPrimitive.Content
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          if (!restoreFocusTo?.isConnected) return;
          event.preventDefault();
          restoreFocusTo.focus({ preventScroll: true });
        }}
        className={cn(
          // `@container`: the dialog is its own query container, so a form laid
          // out inside it responds to the dialog's width rather than the page's.
          // Without this, `@[560px]:grid-cols-2` inside a dialog never matches.
          '@container',
          'fixed left-1/2 top-1/2 z-dialog w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
          'rounded-card border border-border bg-surface-1 p-5 shadow-dialog outline-none',
          'data-[state=open]:animate-scale-in',
          SIZES[size],
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            aria-label="Close"
            className={cn(
              'absolute right-3 top-3 flex size-7 items-center justify-center rounded-control',
              'text-text-subtle transition duration-(--dur-micro) ease-out',
              'hover:bg-surface-2 hover:text-text',
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('mb-4 flex flex-col gap-1 pr-8', className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-base font-semibold text-text', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-xs text-text-muted', className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cn('mt-5 flex items-center justify-end gap-2 border-t border-border pt-4', className)}
      {...props}
    />
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm action as destructive. */
  destructive?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}

/** Destructive or affirmative confirmation, used across every list page. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <DialogClose asChild>
            <button
              type="button"
              className="h-9 rounded-control border border-border bg-surface-2 px-3.5 text-sm font-medium text-text transition duration-(--dur-micro) ease-out hover:bg-surface-3"
            >
              {cancelLabel}
            </button>
          </DialogClose>
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            className={cn(
              'h-9 rounded-control px-3.5 text-sm font-medium text-accent-contrast transition duration-(--dur-micro) ease-out hover:opacity-90',
              destructive ? 'bg-danger' : 'bg-accent',
            )}
          >
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
