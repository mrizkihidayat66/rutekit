import { X } from 'lucide-react';
import { useCallback, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useModalFocus } from '@web/hooks/useModalFocus.ts';
import { usePresence } from '@web/hooks/usePresence.ts';
import { cn } from '@web/lib/cn.ts';

const EXIT_MS = 150;

const WIDTHS = {
  sm: 'w-[min(20rem,92vw)]',
  md: 'w-[min(26rem,92vw)]',
  lg: 'w-[min(36rem,92vw)]',
} as const;

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  side?: 'right' | 'left';
  width?: keyof typeof WIDTHS;
}

/**
 * The hand-rolled overlay, kept deliberately on the shared `usePresence` +
 * `useModalFocus` contract (PRD §7.3) so the command palette and any future
 * overlay behave exactly like this one. The backdrop is a real `<button>`, so
 * it is reachable and dismissable from the keyboard rather than being a
 * decorative div with an onClick.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  side = 'right',
  width = 'md',
}: DrawerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { mounted, closing } = usePresence(open, EXIT_MS);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useModalFocus({
    active: open && mounted,
    containerRef,
    onEscape: close,
  });

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-drawer">
      <button
        type="button"
        aria-label="Close panel"
        onClick={close}
        className={cn(
          'absolute inset-0 cursor-default bg-scrim backdrop-blur-[2px]',
          closing ? 'animate-fade-out' : 'animate-fade-in',
        )}
      />

      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description ? { 'aria-describedby': descriptionId } : {})}
        className={cn(
          // `@container`: the panel is its own query container, so a two-column
          // block inside it responds to the drawer's width rather than the
          // page's — the same arrangement `Dialog` uses.
          '@container',
          'absolute inset-y-0 flex flex-col border-border bg-surface-1 shadow-dialog',
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
          WIDTHS[width],
          side === 'right'
            ? closing
              ? 'animate-slide-out-right'
              : 'animate-slide-in-right'
            : closing
              ? 'animate-slide-out-left'
              : 'animate-slide-in-left',
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold text-text">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-xs text-text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-control text-text-subtle',
              'transition duration-(--dur-micro) ease-out hover:bg-surface-2 hover:text-text',
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="scrollbar-none flex-1 overflow-y-auto p-4">{children}</div>

        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
