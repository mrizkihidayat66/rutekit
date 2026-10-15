import { useEffect, useRef, useState } from 'react';

import { useReducedMotion } from './useMediaQuery.ts';

export interface Presence {
  /** Whether the element should be in the DOM at all. */
  mounted: boolean;
  /** True while the exit animation is playing. Apply the exit class here. */
  closing: boolean;
  /** Value for a `data-state` attribute, for CSS that keys off it. */
  state: 'open' | 'closed';
}

/**
 * Keep an element mounted long enough to play its exit animation (PRD §7.3).
 *
 * React unmounts synchronously, so without this every dialog and drawer would
 * vanish instead of animating out. `exitMs` should match the exit animation's
 * duration token; under `prefers-reduced-motion` the delay collapses to a frame
 * so reduced-motion users are not left waiting on an invisible animation.
 */
export function usePresence(open: boolean, exitMs: number): Presence {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setMounted(true);
      setClosing(false);
      return;
    }

    if (!mounted) return;

    setClosing(true);
    const delay = reducedMotion ? 0 : exitMs;
    timer.current = setTimeout(() => {
      timer.current = null;
      setMounted(false);
      setClosing(false);
    }, delay);

    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open, mounted, exitMs, reducedMotion]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return { mounted, closing, state: open ? 'open' : 'closed' };
}
