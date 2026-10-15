import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Badge } from '@web/components/ui/Badge.tsx';
import { cn } from '@web/lib/cn.ts';
import { hoursFromNow } from '@web/mocks/clock.ts';
import { db } from '@web/mocks/db.ts';
import { mockMode, setMockMode, type MockMode } from '@web/mocks/latency.ts';

/**
 * A dev-only corner switch that puts the whole console into one of its four
 * response states, so the skeleton, the empty table and the error panel can be
 * looked at on a real page instead of only in the showcase. It is dropped from
 * a production build entirely: `App` imports it lazily behind a statically-false
 * `import.meta.env.DEV`, so the chunk is never requested and never emitted.
 *
 * It also carries the two auth states the fixture does not start in. The mock
 * instance is configured and signed in from the first frame — the normal case —
 * which leaves `/login` and `/setup` with no way to be reached and therefore no
 * way to be looked at. The buttons below write the auth record the guard reads
 * and drop every cache, so the whole loop is real: sign out, sign back in, and
 * walk the first-run wizard from an instance that has never been set up.
 */

const MODES: readonly { id: MockMode; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'slow', label: 'Slow' },
  { id: 'loading', label: 'Loading' },
  { id: 'empty', label: 'Empty' },
  { id: 'error', label: 'Error' },
];

/**
 * The three states the guard can be in, so a review can step through the whole
 * loop without reloading: the fixture starts signed in, "Signed out" lands on
 * `/login`, and "First run" drops the instance back to the wizard. A reload
 * always restores the signed-in fixture, because the mock database is in memory.
 */
const AUTH_STATES: readonly {
  id: string;
  label: string;
  configured: boolean;
  authenticated: boolean;
}[] = [
  { id: 'signed-in', label: 'Signed in', configured: true, authenticated: true },
  { id: 'signed-out', label: 'Signed out', configured: true, authenticated: false },
  { id: 'first-run', label: 'First run', configured: false, authenticated: false },
];

export function MockFlipper() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<MockMode>(() => mockMode());

  function choose(next: MockMode): void {
    setMockMode(next);
    setMode(next);
    void queryClient.invalidateQueries();
  }

  function setAuth(configured: boolean, authenticated: boolean): void {
    db.authStatus.configured = configured;
    db.authStatus.authenticated = authenticated;
    db.authStatus.sessionExpiresAt = authenticated ? hoursFromNow(12) : null;
    void queryClient.invalidateQueries();
  }

  return (
    <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2 rounded-card border border-border bg-surface-2/95 p-2 shadow-lg backdrop-blur">
      <div className="flex items-center justify-between gap-3 px-1">
        <span className="text-[0.6875rem] font-semibold tracking-wide text-text-muted uppercase">
          Mock
        </span>
        <Badge tone={mode === 'normal' ? 'neutral' : 'warning'} size="sm">
          {mode}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1">
        {MODES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={mode === entry.id}
            onClick={() => choose(entry.id)}
            className={cn(
              'rounded-pill px-2 py-0.5 text-xs font-medium transition duration-(--dur-micro) ease-out',
              mode === entry.id
                ? 'bg-accent text-accent-contrast'
                : 'bg-surface-3 text-text-muted hover:text-text',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1 border-t border-border px-1 pt-2">
        <span className="mr-auto text-[0.6875rem] font-semibold tracking-wide text-text-muted uppercase">
          Auth
        </span>
        {AUTH_STATES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              setAuth(entry.configured, entry.authenticated);
            }}
            className="rounded-pill bg-surface-3 px-2 py-0.5 text-xs font-medium text-text-muted transition duration-(--dur-micro) ease-out hover:text-text"
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}
