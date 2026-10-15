import { z } from 'zod';

/**
 * A provider with nothing to check, and the reason why.
 *
 * The `reason` is required on purpose. ADR-0006 lets a provider ship without a
 * quota checker only if the omission is written down: a manifest with no quota
 * block at all would make "we have not got to this one" and "this provider has
 * no quota" look identical on the page, and the second is a claim a reviewer has
 * to be able to read and disagree with.
 */
export const noQuotaPolicySchema = z.object({
  kind: z.literal('none'),
  reason: z.string().min(1),
});

/**
 * A rate allowance that refills on a clock, and what the provider enforces.
 *
 * `windows` is the provider's own shape — the usual pair is an hourly and a
 * daily one — and it is declared rather than discovered so the console can label
 * a reset ("resets 14:00") before the first check-in has ever run. An empty list
 * means the provider enforces a limit but does not advertise its window, which is
 * still worth a row.
 */
export const windowQuotaPolicySchema = z.object({
  kind: z.literal('window'),
  source: z.enum(['headers', 'endpoint']),
  /** The endpoint to poll; null when the numbers arrive on response headers. */
  path: z.string().min(1).nullable().default(null),
  windows: z
    .array(
      z.object({
        windowSeconds: z.number().int().positive(),
        label: z.string().min(1),
      }),
    )
    .default([]),
});

/**
 * A balance that is spent down and does not refill.
 *
 * Separate from a window because it answers a different question — "how much is
 * left" rather than "when does this reset" — and the console renders the two as
 * different things. Collapsing them into one shape would mean every field of
 * both carried as optional, and a row that has to guess which kind it is.
 */
export const creditQuotaPolicySchema = z.object({
  kind: z.literal('credit'),
  source: z.enum(['headers', 'endpoint']),
  path: z.string().min(1).nullable().default(null),
});

export const quotaPolicySchema = z.discriminatedUnion('kind', [
  noQuotaPolicySchema,
  windowQuotaPolicySchema,
  creditQuotaPolicySchema,
]);

export type QuotaPolicy = z.infer<typeof quotaPolicySchema>;
