import { Info } from 'lucide-react';

import type { VerificationResult } from '@contracts';

import { Card, CardBody, CardHeader } from '@web/components/ui/Card.tsx';
import { BarList } from '@web/components/patterns/BarList.tsx';
import { formatRatio } from '@web/lib/format.ts';

import { claimedMass, leadingFamily, posteriorItems, verdictHeadline } from './verification.ts';

/**
 * Where the evidence landed: a distribution over families, not a verdict.
 *
 * This is the page's headline because it is the honest shape of the finding. A
 * bar chart of posterior mass says "the behaviour looks like this, and here is
 * how much of it looks like that" — which is what the probes can actually
 * support. A single name in a big font would say more than the evidence does,
 * and that is exactly the overclaim ADR-0017 exists to prevent.
 */

export interface VerificationPosteriorProps {
  readonly result: VerificationResult;
}

export function VerificationPosterior({ result }: VerificationPosteriorProps) {
  const items = posteriorItems(result.posterior);
  const lead = leadingFamily(result);
  const mass = claimedMass(result);

  return (
    <Card>
      <CardHeader
        title="Family posterior"
        description="How much of the observed behaviour matches each candidate family."
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-text-muted">{verdictHeadline(result)}</p>

        <BarList items={items} />

        <p className="inline-flex items-start gap-1.5 text-[0.6875rem] text-text-subtle">
          <Info aria-hidden="true" className="mt-px size-3 shrink-0" />
          <span>
            Bars are posterior mass, not proof. The claimed family is marked so it can be found, not
            because it won — {formatRatio(mass)} of the mass is on it, and the strongest candidate is{' '}
            {lead === null ? '—' : lead.family}.
          </span>
        </p>
      </CardBody>
    </Card>
  );
}
