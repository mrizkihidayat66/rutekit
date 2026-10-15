import type { AccountState } from '@contracts';

import { cn } from '@web/lib/cn.ts';

import { ACCOUNT_STATE_CHIP, ACCOUNT_STATE_DOT, ACCOUNT_STATE_LABELS } from './provider-vocabulary.ts';

/**
 * An account's pool state as a chip.
 *
 * It is deliberately not the generic `Badge`: the seven states carry the
 * `--color-state-*` palette (app.css) so the same colour means the same thing
 * here, in a quota row and in the dashboard's pool card. Reusing `Badge` would
 * have flattened `exhausted` and `rate_limited` into the same warning.
 *
 * The label is always the state's name, never an icon alone — colour is the
 * second signal, not the only one (RULESET R4.7).
 */

type BadgeSize = 'sm' | 'md';

const SIZES: Record<BadgeSize, string> = {
  sm: 'h-5 px-1.5 text-[0.6875rem]',
  md: 'h-6 px-2 text-xs',
};

export interface AccountStateBadgeProps {
  readonly state: AccountState;
  readonly size?: BadgeSize;
  /** The leading dot; on by default, off in a dense legend. */
  readonly dot?: boolean;
  readonly className?: string;
}

export function AccountStateBadge({ state, size = 'md', dot = true, className }: AccountStateBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-pill border font-medium whitespace-nowrap',
        ACCOUNT_STATE_CHIP[state],
        SIZES[size],
        className,
      )}
    >
      {dot ? (
        <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-pill', ACCOUNT_STATE_DOT[state])} />
      ) : null}
      {ACCOUNT_STATE_LABELS[state]}
    </span>
  );
}
