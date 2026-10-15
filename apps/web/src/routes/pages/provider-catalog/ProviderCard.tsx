import { Bot, Eye, Gauge, KeyRound, Wrench } from 'lucide-react';
import { Link } from 'react-router';

import type { Provider } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import {
  PROVIDER_CATEGORY_LABELS,
  PROVIDER_STATUS_LABELS,
  PROVIDER_STATUS_TONES,
} from '@web/components/patterns/provider-vocabulary.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

/**
 * One provider in the catalog grid.
 *
 * The whole card is a link, not a card with a link in it: a provider is the
 * thing the operator came to configure, so there is exactly one action and the
 * target is the entire surface. That also makes it keyboard-reachable for free
 * (RULESET R4.1) rather than needing a click handler and a role.
 *
 * What it shows is chosen to answer "should I turn this on?": whether it is
 * reachable, whether it is free, how many models and credentials it has, and
 * which capabilities the router can actually use. Everything else belongs on the
 * detail page.
 */

interface ProviderCardProps {
  readonly provider: Provider;
}

export function ProviderCard({ provider }: ProviderCardProps) {
  const { capabilities } = provider;

  return (
    <Link
      to={`/providers/${provider.id}`}
      className={cn(
        'card-surface group flex h-full w-full flex-col gap-3 p-4',
        'transition duration-(--dur-micro) ease-out',
        'hover:-translate-y-0.5 hover:border-border-strong hover:shadow-card',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        'outline-none focus-visible:ring-2 focus-visible:ring-focus',
      )}
    >
      <div className="flex items-start gap-3">
        <ProviderIcon icon={provider.icon} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-text">{provider.name}</span>
          <span className="truncate text-xs text-text-muted">
            {PROVIDER_CATEGORY_LABELS[provider.category]}
          </span>
        </div>
        <Badge
          tone={PROVIDER_STATUS_TONES[provider.status]}
          size="sm"
          dot
          pulse={provider.status === 'ready'}
        >
          {PROVIDER_STATUS_LABELS[provider.status]}
        </Badge>
      </div>

      <p className="line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-text-muted">
        {provider.description}
      </p>

      <CapabilityRow
        quota={capabilities.quota}
        oauth={capabilities.oauth}
        automation={capabilities.automation}
        vision={capabilities.vision}
        tools={capabilities.tools}
      />

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-text-muted">
        <span className="tabular-nums">{formatCount(provider.modelCount)} models</span>
        <span aria-hidden="true" className="text-text-subtle">
          ·
        </span>
        <span className="tabular-nums">
          {formatCount(provider.activeAccountCount)}/{formatCount(provider.accountCount)} accounts
        </span>
        {provider.freeTier ? (
          <Badge tone="accent" size="sm" className="ml-auto">
            Free tier
          </Badge>
        ) : null}
      </div>
    </Link>
  );
}

interface CapabilityRowProps {
  readonly quota: boolean;
  readonly oauth: boolean;
  readonly automation: boolean;
  readonly vision: boolean;
  readonly tools: boolean;
}

/**
 * The capabilities worth a chip, in the order an operator cares about them.
 *
 * Only the true ones render — an absent capability is the default, and a row of
 * five greyed-out chips would be noise on every card in the grid.
 */
function CapabilityRow({ quota, oauth, automation, vision, tools }: CapabilityRowProps) {
  const chips = [
    quota ? { key: 'quota', icon: Gauge, label: 'Quota' } : null,
    oauth ? { key: 'oauth', icon: KeyRound, label: 'OAuth' } : null,
    automation ? { key: 'automation', icon: Bot, label: 'Automation' } : null,
    vision ? { key: 'vision', icon: Eye, label: 'Vision' } : null,
    tools ? { key: 'tools', icon: Wrench, label: 'Tools' } : null,
  ].filter((chip) => chip !== null);

  if (chips.length === 0) return <div className="min-h-[1.25rem]" />;

  return (
    <ul className="flex min-h-[1.25rem] flex-wrap gap-1">
      {chips.map(({ key, icon: Icon, label }) => (
        <li
          key={key}
          className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface-2 px-1.5 py-0.5 text-[0.6875rem] text-text-muted"
        >
          <Icon aria-hidden="true" className="size-3" />
          {label}
        </li>
      ))}
    </ul>
  );
}
