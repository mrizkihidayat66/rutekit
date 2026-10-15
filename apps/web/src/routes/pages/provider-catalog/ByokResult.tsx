import { ArrowRight, CircleCheck, CircleX } from 'lucide-react';

import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import {
  PROVIDER_CATEGORY_LABELS,
  WIRE_FAMILY_LABELS,
} from '@web/components/patterns/provider-vocabulary.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/Dialog.tsx';
import type { ProviderOnboarding } from '@web/hooks/use-providers.ts';
import { formatCount } from '@web/lib/format.ts';

/**
 * What the BYOK wizard found.
 *
 * Shown inside the dialog rather than as a redirect, because a failed probe is
 * information the operator needs while the fields are still in front of them.
 * The provider exists either way — it is a configured thing they can go and fix,
 * not a failed transaction — so the panel always offers the way onward and never
 * presents itself as an error page.
 */

interface ByokResultProps {
  readonly result: ProviderOnboarding;
  readonly onOpen: () => void;
}

/** How many discovered models to name before collapsing the rest into a count. */
const PREVIEW_LIMIT = 4;

export function ByokResult({ result, onOpen }: ByokResultProps) {
  const { provider, models, test } = result;
  const preview = models.slice(0, PREVIEW_LIMIT);
  const hidden = models.length - preview.length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{test.ok ? 'Endpoint verified' : 'Endpoint added, but it did not answer'}</DialogTitle>
        <DialogDescription>
          {test.ok
            ? 'The endpoint listed its models and answered a probe. Traffic can route to it as soon as a credential is attached.'
            : 'The provider was saved so you can correct it. Check the base URL and the key, then probe it again from the detail page.'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-card border border-border bg-surface-2 p-3">
          <ProviderIcon icon={provider.icon} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold text-text">{provider.name}</span>
            <span className="truncate text-xs text-text-muted">
              {PROVIDER_CATEGORY_LABELS[provider.category]} · {WIRE_FAMILY_LABELS[provider.wireFamily]}
            </span>
          </div>
          <Badge tone={test.ok ? 'success' : 'danger'} size="sm" dot>
            {test.ok ? 'Reachable' : 'Unreachable'}
          </Badge>
        </div>

        <dl className="grid grid-cols-2 gap-3">
          <div className="rounded-card border border-border bg-surface-2 p-3">
            <dt className="text-xs text-text-muted">Round trip</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums text-text">
              {test.latencyMs === null ? '—' : `${formatCount(test.latencyMs)} ms`}
            </dd>
          </div>
          <div className="rounded-card border border-border bg-surface-2 p-3">
            <dt className="text-xs text-text-muted">Models discovered</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums text-text">
              {test.modelCount === null ? '—' : formatCount(test.modelCount)}
            </dd>
          </div>
        </dl>

        {preview.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-text-muted">Discovered models</p>
            <ul className="flex flex-wrap gap-1">
              {preview.map((model) => (
                <li
                  key={model.id}
                  className="rounded-key border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[0.6875rem] text-text-muted"
                >
                  {model.displayName}
                </li>
              ))}
              {hidden > 0 ? (
                <li className="px-1.5 py-0.5 text-[0.6875rem] tabular-nums text-text-subtle">
                  +{formatCount(hidden)} more
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

        <p className="flex items-start gap-2 text-xs text-text-muted">
          {test.ok ? (
            <CircleCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
          ) : (
            <CircleX aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-danger" />
          )}
          {test.message}
        </p>
      </div>

      <DialogFooter>
        <Button onClick={onOpen}>
          Open provider
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Button>
      </DialogFooter>
    </>
  );
}
