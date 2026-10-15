import { KeyRound } from 'lucide-react';
import { Link } from 'react-router';

import { type ApiKey, type ApiKeyState, deriveApiKeyState } from '@contracts';

import { Meter } from '@web/components/patterns/Meter.tsx';
import type { Tone } from '@web/components/patterns/tone.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatRelative, formatTokens } from '@web/lib/format.ts';

/**
 * The keys pointing at this instance, with their budgets.
 *
 * A key's *state* is derived (`deriveApiKeyState`) rather than stored, so the
 * badge here and the badge on the API Keys page cannot disagree — expiry and
 * exhaustion are computed from the same numbers the meters draw.
 *
 * An unlimited budget draws no meter: an empty bar would read as "nothing
 * left", which is the opposite of what it means.
 */

export interface ApiKeyPanelProps {
  readonly apiKeys: readonly ApiKey[];
  readonly className?: string;
}

const KEY_STATE_TONE: Record<ApiKeyState, Tone> = {
  active: 'success',
  expired: 'warning',
  revoked: 'neutral',
  exhausted: 'danger',
};

function budgetTone(used: number, budget: number): Tone {
  const ratio = budget > 0 ? used / budget : 0;
  if (ratio >= 0.9) return 'danger';
  if (ratio >= 0.75) return 'warning';
  return 'accent';
}

interface BudgetRowProps {
  readonly label: string;
  readonly used: number;
  readonly budget: number | null;
  readonly format: (value: number) => string;
}

function BudgetRow({ label, used, budget, format }: BudgetRowProps) {
  if (budget === null) {
    return (
      <div className="flex items-center justify-between gap-2 text-[0.6875rem]">
        <span className="text-text-subtle">{label}</span>
        <span className="tabular-nums text-text-muted">{format(used)} · unlimited</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Meter
        value={used}
        max={budget}
        label={label}
        tone={budgetTone(used, budget)}
        size="sm"
        className="flex-1"
      />
      <span className="shrink-0 text-[0.6875rem] tabular-nums text-text-subtle">
        {format(used)} / {format(budget)}
      </span>
    </div>
  );
}

export function ApiKeyPanel({ apiKeys, className }: ApiKeyPanelProps) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader
        title="API keys"
        description="What is allowed to call this instance, and how much is left."
        actions={
          <Link to="/api-keys" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Manage
          </Link>
        }
      />

      {apiKeys.length === 0 ? (
        <StateView
          kind="empty"
          title="No API keys"
          description="Create a key to start routing requests through rutekit."
          action={
            <Link to="/api-keys" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
              Create a key
            </Link>
          }
        />
      ) : (
        <ul role="list" className="flex flex-col gap-4">
          {apiKeys.map((key) => {
            const state = deriveApiKeyState(key);
            const tokensUsed = key.usage.inputTokens + key.usage.outputTokens;
            return (
              <li key={key.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <KeyRound className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
                    <span className="truncate text-xs font-medium text-text">{key.name}</span>
                    <span className="shrink-0 font-mono text-[0.6875rem] text-text-subtle">{key.prefix}…</span>
                  </div>
                  <Badge tone={KEY_STATE_TONE[state]} size="sm" dot>
                    {state}
                  </Badge>
                </div>

                <div className="flex flex-col gap-1.5">
                  <BudgetRow
                    label={`${key.name} request budget`}
                    used={key.usage.requests}
                    budget={key.budgetRequests}
                    format={formatCount}
                  />
                  <BudgetRow
                    label={`${key.name} token budget`}
                    used={tokensUsed}
                    budget={key.budgetTokens}
                    format={formatTokens}
                  />
                </div>

                <dl className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-text-subtle">
                  <div className="flex items-center gap-1">
                    <dt>expires</dt>
                    <dd className="text-text-muted">
                      {key.expiresAt === null ? 'never' : formatRelative(key.expiresAt)}
                    </dd>
                  </div>
                  <div className="flex items-center gap-1">
                    <dt>tps</dt>
                    <dd className="tabular-nums text-text-muted">{key.tpsLimit ?? '∞'}</dd>
                  </div>
                  <div className="flex items-center gap-1">
                    <dt>rpm</dt>
                    <dd className="tabular-nums text-text-muted">{key.rateLimitPerMinute ?? '∞'}</dd>
                  </div>
                  <div className="flex items-center gap-1">
                    <dt>last used</dt>
                    <dd className="text-text-muted">
                      {key.lastUsedAt === null ? 'never' : formatRelative(key.lastUsedAt)}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
