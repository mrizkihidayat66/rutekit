import { z } from 'zod';

/**
 * How rutekit learns which models a provider serves.
 *
 * `static` is not a failure mode. A local runner serves whatever the operator
 * installed and has no catalogue to ask for, and a provider with a short, fixed,
 * documented list is served entirely from the manifest's own `models`. Asking
 * either one would return nothing useful.
 *
 * `requiresCredential` exists because a handful of listings are themselves
 * authenticated calls. Probing one without a credential would report a failure
 * that says nothing about the endpoint, so the probe has to know the difference
 * before it decides what a rejection means.
 *
 * `passthrough` is the escape hatch that keeps the catalogue honest: when an
 * endpoint serves a model id rutekit has never heard of, a passthrough provider
 * routes it anyway rather than rejecting a request the upstream would have
 * accepted. It is off by default because a router that forwards unknown ids
 * silently cannot tell an operator which ids it actually knows.
 */
export const discoverySchema = z.object({
  strategy: z.enum(['openai', 'anthropic', 'google', 'static']),
  /** Override the listing path; null takes the strategy's default. */
  path: z.string().min(1).nullable().default(null),
  requiresCredential: z.boolean().default(true),
  passthrough: z.boolean().default(false),
});

export type Discovery = z.infer<typeof discoverySchema>;
