import { KeyRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import type { Provider } from '@contracts';

import { cn } from '@web/lib/cn.ts';

/**
 * What the console is allowed to say about a credential.
 *
 * Every credential in rutekit is write-only: it is accepted once and never
 * appears on any read model (contracts `providerInputSchema.apiKey`,
 * `accountInputSchema.credential`). An operator who has just pasted a key needs
 * to know that the blank field on the page is not a bug — so this notice is
 * always shown next to wherever a credential can be entered, not hidden behind a
 * tooltip.
 *
 * It states the situation for *this* provider rather than reciting policy: a
 * provider with no accounts reads differently from one that is already signed in.
 */

interface CredentialNoticeProps {
  readonly provider: Provider;
  readonly className?: string;
}

export function CredentialNotice({ provider, className }: CredentialNoticeProps) {
  const { accountCount, activeAccountCount, capabilities } = provider;

  if (accountCount === 0) {
    return (
      <Notice
        tone="warning"
        icon={<TriangleAlert aria-hidden="true" className="size-4" />}
        title="No credential is attached yet"
        className={className}
      >
        Add one from the Accounts page{capabilities.oauth ? ', or sign in below,' : ','} and the router
        will start sending this provider traffic.
      </Notice>
    );
  }

  return (
    <Notice
      tone="neutral"
      icon={<ShieldCheck aria-hidden="true" className="size-4" />}
      title="Credentials are stored write-only"
      className={className}
    >
      <span className="tabular-nums">
        {activeAccountCount} of {accountCount}
      </span>{' '}
      {accountCount === 1 ? 'credential is' : 'credentials are'} in the rotation. The values themselves
      are never sent back to the browser, so this page can show what a credential is doing but not what it
      is.
    </Notice>
  );
}

/** A one-line key hint, for the BYOK wizard's credential field. */
export function CredentialFieldHint() {
  return (
    <span className="inline-flex items-center gap-1">
      <KeyRound aria-hidden="true" className="size-3" />
      Stored write-only — it cannot be read back after saving.
    </span>
  );
}

interface NoticeProps {
  readonly tone: 'neutral' | 'warning';
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

const TONES: Record<NoticeProps['tone'], string> = {
  neutral: 'border-border bg-surface-2',
  warning: 'border-warning/30 bg-warning/8',
};

const TITLE_TONES: Record<NoticeProps['tone'], string> = {
  neutral: 'text-text',
  warning: 'text-warning',
};

function Notice({ tone, icon, title, children, className }: NoticeProps) {
  return (
    <div className={cn('flex items-start gap-3 rounded-card border p-3', TONES[tone], className)}>
      <span className={cn('mt-0.5 shrink-0', TITLE_TONES[tone])}>{icon}</span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className={cn('text-xs font-medium', TITLE_TONES[tone])}>{title}</p>
        <p className="text-xs text-text-muted">{children}</p>
      </div>
    </div>
  );
}
