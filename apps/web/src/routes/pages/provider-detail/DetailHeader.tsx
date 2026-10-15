import { ArrowLeft, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import type { Provider } from '@contracts';

import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import {
  PROVIDER_CATEGORY_LABELS,
  PROVIDER_STATUS_LABELS,
  PROVIDER_STATUS_TONES,
  WIRE_FAMILY_LABELS,
} from '@web/components/patterns/provider-vocabulary.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { cn } from '@web/lib/cn.ts';

/**
 * The detail page's heading.
 *
 * It is deliberately not `PageHeader`: this page is about one named thing, so the
 * identity is the heading — the provider's own glyph, its name, and the four
 * facts that tell an operator whether it is the right provider before they read
 * a single card (category, wire dialect, endpoint, docs). The back link is a real
 * link to the catalog rather than a history pop, because "back to the list" is
 * where an operator is going, not where they came from.
 */

export interface DetailHeaderProps {
  readonly provider: Provider;
  readonly actions: ReactNode;
  readonly className?: string;
}

export function DetailHeader({ provider, actions, className }: DetailHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Link
        to="/providers"
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 w-fit text-text-muted')}
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Providers
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <ProviderIcon icon={provider.icon} size="lg" />

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-head text-lg font-semibold tracking-tight text-text">
                {provider.name}
              </h1>
              <Badge
                tone={PROVIDER_STATUS_TONES[provider.status]}
                dot
                pulse={provider.status === 'ready'}
              >
                {PROVIDER_STATUS_LABELS[provider.status]}
              </Badge>
              {provider.freeTier ? (
                <Badge tone="accent" size="sm">
                  Free tier
                </Badge>
              ) : null}
            </div>

            <p className="mt-1 max-w-2xl text-xs text-text-muted">{provider.description}</p>

            <dl className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-text-subtle">
              <div className="flex items-center gap-1.5">
                <dt className="sr-only">Category</dt>
                <dd>{PROVIDER_CATEGORY_LABELS[provider.category]}</dd>
              </div>
              <span aria-hidden="true">·</span>
              <div className="flex items-center gap-1.5">
                <dt className="sr-only">Wire family</dt>
                <dd>{WIRE_FAMILY_LABELS[provider.wireFamily]} wire</dd>
              </div>
              {provider.baseUrl === null ? null : (
                <>
                  <span aria-hidden="true">·</span>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <dt className="sr-only">Base URL</dt>
                    <dd className="truncate font-mono">{provider.baseUrl}</dd>
                  </div>
                </>
              )}
              {provider.docsUrl === null ? null : (
                <>
                  <span aria-hidden="true">·</span>
                  <a
                    href={provider.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-control outline-none transition duration-(--dur-micro) ease-out hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    Documentation
                    <ExternalLink aria-hidden="true" className="size-3" />
                  </a>
                </>
              )}
            </dl>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </header>
    </div>
  );
}
