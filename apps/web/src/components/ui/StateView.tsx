import {
  AlertTriangle,
  Inbox,
  Loader2,
  Lock,
  SearchX,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

export type StateKind = 'empty' | 'no-results' | 'loading' | 'error' | 'offline' | 'locked';

interface StatePreset {
  icon: LucideIcon;
  title: string;
  description: string;
  tone: 'neutral' | 'danger';
}

const PRESETS: Record<StateKind, StatePreset> = {
  empty: {
    icon: Inbox,
    title: 'Nothing here yet',
    description: 'Once there is data to show, it will appear here.',
    tone: 'neutral',
  },
  'no-results': {
    icon: SearchX,
    title: 'No matches',
    description: 'Try widening the filters or clearing the search.',
    tone: 'neutral',
  },
  loading: {
    icon: Loader2,
    title: 'Loading',
    description: 'Fetching the latest data.',
    tone: 'neutral',
  },
  error: {
    icon: AlertTriangle,
    title: 'Something went wrong',
    description: 'The request failed. Retrying may help.',
    tone: 'danger',
  },
  offline: {
    icon: WifiOff,
    title: 'Backend unreachable',
    description: 'rutekit could not reach its own API. Check that the server is running.',
    tone: 'danger',
  },
  locked: {
    icon: Lock,
    title: 'Sign in required',
    description: 'This view needs an authenticated session.',
    tone: 'neutral',
  },
};

export interface StateViewProps {
  kind: StateKind;
  /** Overrides the preset title. */
  title?: ReactNode;
  /** Overrides the preset description. */
  description?: ReactNode;
  /** Primary action, e.g. a Retry button. */
  action?: ReactNode;
  /** Replaces the preset icon. */
  icon?: LucideIcon;
  className?: string;
}

/**
 * The single presentation of "there is nothing to render". Every list, table
 * and panel uses this so empty and error states never look improvised.
 */
export function StateView({
  kind,
  title,
  description,
  action,
  icon,
  className,
}: StateViewProps) {
  const preset = PRESETS[kind];
  const Icon = icon ?? preset.icon;

  return (
    <div
      role={kind === 'error' || kind === 'offline' ? 'alert' : 'status'}
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        'animate-rise',
        className,
      )}
    >
      <span
        className={cn(
          'mb-1 flex size-11 items-center justify-center rounded-pill border',
          preset.tone === 'danger'
            ? 'border-danger/25 bg-danger/10 text-danger'
            : 'border-border bg-surface-2 text-text-muted',
        )}
      >
        <Icon className={cn('size-5', kind === 'loading' && 'animate-spin-slow')} aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-text">{title ?? preset.title}</p>
      <p className="max-w-sm text-xs text-text-muted">{description ?? preset.description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
