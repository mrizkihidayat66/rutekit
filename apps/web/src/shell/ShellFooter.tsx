import { useRef, useSyncExternalStore } from 'react';

import { formatDuration, useClock, useElapsed } from '@web/hooks/useClock.ts';
import { getImmersive, subscribeImmersive } from '@web/shell/immersive.ts';

const utcFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const localFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * Isolated so the once-a-second tick re-renders the clock and not the shell.
 * Uptime is the session's own age; the server's uptime arrives with the API.
 */
function Clock() {
  const now = useClock();
  const start = useRef(Date.now());
  const elapsed = useElapsed(start.current);

  return (
    <div className="flex items-center gap-4 text-xs text-text-muted">
      <span className="flex items-center gap-1.5">
        <span className="text-text-subtle">UTC</span>
        <time dateTime={now.toISOString()}>{utcFormatter.format(now)}</time>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-text-subtle">Local</span>
        <time dateTime={now.toISOString()}>{localFormatter.format(now)}</time>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-text-subtle">Uptime</span>
        <span>{formatDuration(elapsed)}</span>
      </span>
    </div>
  );
}

/** The shell's status bar: build identity on the left, the clocks on the right. */
export function ShellFooter() {
  const version = import.meta.env.VITE_RUTEKIT_VERSION ?? 'dev';
  // An immersive route — the chat — gives its window back to the transcript.
  const hidden = useSyncExternalStore(subscribeImmersive, getImmersive, getImmersive);
  if (hidden) return null;

  return (
    <footer className="flex h-footer shrink-0 items-center justify-between gap-3 border-t border-border px-3">
      <p className="truncate text-xs text-text-subtle">
        rutekit <span className="tabular-nums">{version}</span>
      </p>
      <Clock />
    </footer>
  );
}
