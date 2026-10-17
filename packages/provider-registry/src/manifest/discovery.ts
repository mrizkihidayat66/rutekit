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
  /**
   * Where a health probe asks, when the listing endpoint is not it.
   *
   * **`static` discovery means there is no listing, and the probe used to stop
   * there.** A provider whose models are curated has nothing to list, so the
   * probe had no path, returned null, and the account was never checked — which
   * meant a newly imported account stayed `pending` forever and never entered the
   * rotation. Twelve providers are in that position, and two of them are the ones
   * with browser automation.
   *
   * So a provider that cannot be listed can still be *asked something*, and this
   * is where it says what. The path is joined to the base URL exactly as a
   * listing path is, and the answer is read the same way: a 2xx proves the
   * credential, a 401 or 403 says it is dead, and anything else is the provider's
   * own trouble rather than the account's.
   *
   * Null for a provider that genuinely has nothing to ask — a local runner, which
   * has no remote endpoint at all.
   */
  probePath: z.string().min(1).nullable().default(null),
  /**
   * The host the probe lives on, when it is not the manifest's base URL.
   *
   * The same problem `EncodedRequest.origin` solves for a chat request: qoder's
   * base URL is `api3` and its quota endpoint is on `openapi`. A probe aimed at
   * the wrong host answers `404` — which proves nothing about the credential, and
   * which the sweep must not read as success.
   */
  probeOrigin: z.string().min(1).nullable().default(null),
});

export type Discovery = z.infer<typeof discoverySchema>;
