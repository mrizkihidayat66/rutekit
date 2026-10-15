import { useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useModalFocus } from '@web/hooks/useModalFocus.ts';
import { usePresence } from '@web/hooks/usePresence.ts';
import { cn } from '@web/lib/cn.ts';
import { SidebarPanel } from '@web/shell/SidebarPanel.tsx';

const EXIT_MS = 150;

export interface CompactNavProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenPalette?: (() => void) | undefined;
}

/**
 * Below 1024px the rail becomes an off-canvas panel. It runs on the same
 * `usePresence` + `useModalFocus` contract as every other overlay (RULESET
 * R3.8), so Tab trapping, Escape, scroll lock and focus restore behave exactly
 * as they do in the Dialog and Drawer.
 */
export function CompactNav({ open, onOpenChange, onOpenPalette }: CompactNavProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { mounted, closing } = usePresence(open, EXIT_MS);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useModalFocus({ active: open && mounted, containerRef, onEscape: close });

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-drawer">
      <button
        type="button"
        aria-label="Close navigation"
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
        aria-label="Navigation"
        className={cn(
          'absolute inset-y-0 left-0 flex w-[min(17rem,86vw)] flex-col border-r border-border bg-surface-1 shadow-dialog',
          closing ? 'animate-slide-out-left' : 'animate-slide-in-left',
        )}
      >
        <SidebarPanel onOpenPalette={onOpenPalette} />
      </div>
    </div>,
    document.body,
  );
}
