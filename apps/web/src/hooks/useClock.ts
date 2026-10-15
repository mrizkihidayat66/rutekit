import { useEffect, useRef, useState } from 'react';

/**
 * A ticking clock for the shell footer. It lives in its own hook — and its
 * consumers in their own component — so the once-a-second update re-renders the
 * clock and nothing else.
 */
export function useClock(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}

/** Milliseconds since the given `start`, ticking once a second. */
export function useElapsed(start: number): number {
  const [elapsed, setElapsed] = useState(() => Date.now() - start);
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    setElapsed(Date.now() - startRef.current);
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 1000);
    return () => clearInterval(id);
  }, []);

  return elapsed;
}

/** `3661000` → `1h 01m 01s`. Compact, fixed-width, tabular-friendly. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s` : `${pad(minutes)}m ${pad(seconds)}s`;
}
