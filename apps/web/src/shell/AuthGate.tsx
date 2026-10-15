import { Navigate, Outlet, useLocation } from 'react-router';

import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useAuthStatus } from '@web/hooks/use-system.ts';
import { AuthFrame } from '@web/shell/AuthFrame.tsx';

/**
 * Which side of the door a set of routes is on.
 *
 *   session  the console — only reachable with an open session
 *   guest    the way in — only reachable without one
 */
export type AuthGateMode = 'session' | 'guest';

interface RedirectState {
  readonly from?: string;
}

/**
 * Where the guard sent the visitor from.
 *
 * Only a same-origin path is honoured. The value round-trips through history
 * state, and a login page that navigated to whatever absolute URL it was handed
 * would be a redirector for anyone who can craft a link.
 */
function redirectTarget(state: unknown): string {
  if (typeof state !== 'object' || state === null) return '/';
  const from = (state as RedirectState).from;
  if (typeof from !== 'string') return '/';
  return from.startsWith('/') && !from.startsWith('//') ? from : '/';
}

/**
 * The door, in both directions.
 *
 * One component rather than two guards because the two halves have to agree:
 * `session` sends a visitor out and records where they were, `guest` reads that
 * record to send them back. Splitting them would mean two places to change the
 * shape of that hand-off.
 *
 * A single-user instance has three states, not two, and the third is the one
 * worth naming: `configured: false` means nobody has ever set this instance up,
 * so there is no password to be wrong. That is a first run, and the visitor goes
 * to the wizard rather than to a login form that cannot possibly succeed.
 *
 * The auth record is deliberately the only thing either half reads. The session
 * cookie belongs to the server, and until the backend exists the record is the
 * mock's, but the console's own rule is the same either way: the page a visitor
 * sees is a function of what the instance says about itself, never of a flag
 * this app keeps in local storage where a reload could lose it.
 */
export function AuthGate({ mode }: { mode: AuthGateMode }) {
  const location = useLocation();
  const auth = useAuthStatus();

  if (auth.isPending) {
    return (
      <AuthFrame>
        <Card>
          <StateView kind="loading" title="Checking this session" />
        </Card>
      </AuthFrame>
    );
  }

  // An unreachable auth record is the one failure that cannot be routed around:
  // without it there is no way to tell the console from the wizard from a login
  // form, so the honest answer is to say so and offer the retry.
  if (auth.isError) {
    return (
      <AuthFrame>
        <Card>
          <StateView
            kind="error"
            title="Could not reach the instance"
            description="The console API did not answer, so this session could not be checked."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={auth.isFetching}
                onClick={() => {
                  void auth.refetch();
                }}
              >
                Try again
              </Button>
            }
          />
        </Card>
      </AuthFrame>
    );
  }

  const { configured, authenticated } = auth.data;

  if (mode === 'guest') {
    // Already inside: the way in has nothing to offer, so send them back to
    // wherever the guard interrupted them, or to the dashboard if it did not.
    if (authenticated) return <Navigate to={redirectTarget(location.state)} replace />;
    // An unconfigured instance has no password yet, and a configured one has
    // nothing left to set up — so the two pages point at each other rather than
    // relying on the visitor to pick the right one.
    const target = configured ? '/login' : '/setup';
    if (location.pathname !== target) return <Navigate to={target} replace />;
    return <Outlet />;
  }

  if (!configured) return <Navigate to="/setup" replace />;
  if (!authenticated) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }
  return <Outlet />;
}
