import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

export interface ModalFocusOptions {
  /** Whether the modal is currently on screen and should own focus. */
  active: boolean;
  /** The element that contains the modal's content. */
  containerRef: RefObject<HTMLElement | null>;
  /** Called on Escape. Omit to make the modal non-dismissible by keyboard. */
  onEscape?: (() => void) | undefined;
  /** Element to focus on open; falls back to the first focusable descendant. */
  initialFocusRef?: RefObject<HTMLElement | null> | undefined;
}

/**
 * The focus and scroll contract every overlay shares (PRD §7.3, NFR-5).
 *
 *   - Tab cycles inside the container and wraps at both ends.
 *   - Focus that escapes by any other route (click, script) is pulled back.
 *   - Escape closes.
 *   - The page behind is scroll-locked without the layout shifting.
 *   - The page behind is hidden from assistive tech, not just covered visually.
 *   - Focus returns to whatever opened the modal.
 *
 * Radix handles this for the primitives built on it; this hook exists for the
 * hand-rolled overlays (command palette, preview lightbox) so they behave
 * identically.
 */
export function useModalFocus({
  active,
  containerRef,
  onEscape,
  initialFocusRef,
}: ModalFocusOptions): void {
  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    const opener = document.activeElement as HTMLElement | null;

    // The modal's own body-level wrapper, so everything else can be hidden.
    let portalRoot: HTMLElement | null = container;
    while (portalRoot && portalRoot.parentElement !== document.body) {
      portalRoot = portalRoot.parentElement;
    }
    const hidden: { element: Element; previous: string | null }[] = [];

    // Hide the page behind from assistive tech. `aria-modal` alone is the
    // spec's mechanism, but not every screen reader honours it, so the siblings
    // of the portal root are hidden too — the belt-and-braces Radix applies to
    // its dialogs. This runs *after* focus has moved inside, because browsers
    // reject `aria-hidden` on a subtree that still holds focus.
    const hideBehind = (): void => {
      if (!portalRoot) return;
      for (const child of Array.from(document.body.children)) {
        if (child === portalRoot) continue;
        hidden.push({ element: child, previous: child.getAttribute('aria-hidden') });
        child.setAttribute('aria-hidden', 'true');
      }
    };

    // Scroll lock. Compensating for the scrollbar keeps the page from jumping.
    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

    const focusInitial = (): void => {
      const target =
        initialFocusRef?.current ?? focusableWithin(container)[0] ?? container;
      target.focus({ preventScroll: true });
    };
    // A frame's delay lets the enter animation start before focus lands, and
    // gives the hide-behind step a focus-free subtree to mark.
    const frame = requestAnimationFrame(() => {
      focusInitial();
      hideBehind();
    });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        onEscape();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = focusableWithin(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      const active_ = document.activeElement;
      if (event.shiftKey && (active_ === first || active_ === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active_ === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target as Node | null;
      if (target && !container.contains(target)) {
        focusInitial();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
      for (const { element, previous } of hidden) {
        if (previous === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', previous);
      }
      // Restore focus only if the opener is still in the document.
      if (opener && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [active, containerRef, onEscape, initialFocusRef]);
}
