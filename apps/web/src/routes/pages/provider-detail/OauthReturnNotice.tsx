import { CircleCheck, TriangleAlert, X } from 'lucide-react';
import { useSearchParams } from 'react-router';

import { cn } from '@web/lib/cn.ts';

/**
 * What the sign-in left behind in the URL.
 *
 * The provider sends the browser back to the server's callback, and the server
 * bounces it here with the outcome in `?oauth=` — so this is the console's only
 * news that the flow ended, and it has to be read from the query rather than
 * pushed to the page. It is a banner rather than a toast because the operator is
 * arriving from another tab and may not be watching this one; it dismisses by
 * clearing the param, so a reload does not resurrect it.
 *
 * A failed flow is reported, not explained: the reason is in the server log,
 * because the callback path has no body to carry it and putting a raw provider
 * error in a URL would leak it into history and referrers.
 */

export interface OauthReturnNoticeProps {
  readonly providerName: string;
  readonly className?: string;
}

const OUTCOMES = {
  ok: {
    icon: CircleCheck,
    tone: 'border-success/30 bg-success/8 text-success-text',
    title: 'Signed in',
  },
  error: {
    icon: TriangleAlert,
    tone: 'border-danger/30 bg-danger/8 text-danger-text',
    title: 'Sign-in did not finish',
  },
} as const;

type Outcome = keyof typeof OUTCOMES;

function isOutcome(value: string | null): value is Outcome {
  return value === 'ok' || value === 'error';
}

export function OauthReturnNotice({ providerName, className }: OauthReturnNoticeProps) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('oauth');

  if (!isOutcome(raw)) return null;

  const { icon: Icon, tone, title } = OUTCOMES[raw];

  const dismiss = () => {
    const next = new URLSearchParams(params);
    next.delete('oauth');
    setParams(next, { replace: true });
  };

  return (
    <div
      role={raw === 'error' ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-card border p-3', tone, className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-xs text-text-muted">
          {raw === 'ok'
            ? `The new ${providerName} credential is attached. Its accounts list below is up to date.`
            : `The provider refused or the exchange failed. Nothing was saved — check the server log for the reason, then try again.`}
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-control text-text-subtle outline-none transition duration-(--dur-micro) ease-out hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
