import type { WorkerJob } from '@rutekit/contracts';

import { deviceCode } from './device-code.ts';
import { genericLogin } from './generic-login.ts';
import { kiroGoogle } from './kiro-google.ts';
import { qoderGoogle } from './qoder-google.ts';
import type { ProviderFlow } from './types.ts';

/**
 * Which flow drives which provider (C7c).
 *
 * **Explicit, one entry per provider, and no guessing.** A registry that fell back
 * to "try the heuristic on anything" would point a browser form at a provider
 * whose sign-in is a device code, or at one rutekit has never driven — and the
 * failure would arrive as a missing password field rather than as "nobody has
 * written this provider's flow". The difference matters to whoever reads it: the
 * first sends them looking at the provider's page, the second tells them what to
 * do.
 *
 * The one exception is the device flow, and it is not a guess either: a manifest
 * that declares `login: 'device-code'` has *said* which flow it wants, and
 * honouring that is reading the source of truth rather than inferring from it
 * (ADR-0018). So the resolution order is:
 *
 *   1. an explicit entry for this provider id;
 *   2. the device flow, when the manifest declares a device sign-in;
 *   3. nothing — and a failure that names the provider.
 *
 * **Two of the four entries are now flows written against real pages, and the
 * other two are still the heuristic.** kiro and qoder were driven against their
 * live sign-ins, and neither is a single-page form: qoder asks for the email and
 * then the password, and kiro has no form of its own at all — its sign-in is
 * Google's. Both were served by `generic-login` until then, and both failed the
 * way the heuristic is designed to fail, naming the part it could not find.
 *
 * The `codebuddy` pair stay on `generic-login` because nobody has driven their
 * pages. That is not a gap to paper over: a provider whose form the heuristic
 * cannot find fails with a step name saying which part was missing, and that
 * failure is the honest signal that it needs a flow of its own — which is exactly
 * how kiro's and qoder's came to be written.
 */

/** Providers whose sign-in this registry can drive. */
const REGISTRY: Readonly<Record<string, ProviderFlow>> = {
  // No form of its own: the credential is an OAuth code taken through Google,
  // exchanged for the token pair kiro's own client uses (see `kiro-google.ts`).
  kiro: kiroGoogle,
  // A Google sign-in, then a Personal Access Token minted on the integrations
  // page and spent on the token a client uses (see `qoder-google.ts`).
  qoder: qoderGoogle,
  // A console sign-in: an email and a password, then a dashboard with an API key.
  'codebuddy-intl': genericLogin,
  'codebuddy-cn': genericLogin,
};

export interface FlowResolution {
  /** The flow, or null when this provider has none. */
  readonly flow: ProviderFlow | null;
  /** Why there is none, for the failure message. Null when there is one. */
  readonly reason: string | null;
}

/**
 * The flow for this job, or why there is not one.
 *
 * Returns a reason rather than throwing so the caller can name the provider in
 * its own error — the flow registry does not know whether it is being asked by a
 * job, a probe or a test.
 */
export function resolveFlow(job: WorkerJob): FlowResolution {
  const explicit = REGISTRY[job.providerId];
  if (explicit !== undefined) {
    if (explicit.supports(job)) return { flow: explicit, reason: null };
    return {
      flow: null,
      reason: `the ${explicit.name} flow does not handle a ${job.method} job for ${job.providerId}`,
    };
  }

  if (job.automation?.login === 'device-code') {
    // The manifest asked for it, so this is not a fallback — it is the flow the
    // provider declared.
    if (deviceCode.supports(job)) return { flow: deviceCode, reason: null };
    return {
      flow: null,
      reason: `the device-code flow does not handle a ${job.method} job for ${job.providerId}`,
    };
  }

  return {
    flow: null,
    reason: `no sign-in flow is defined for ${job.providerId} yet`,
  };
}

/** Every provider the registry has a flow for, for a test that pins the list. */
export const REGISTERED_PROVIDERS: readonly string[] = Object.keys(REGISTRY);

export { deviceCode, genericLogin };
export type { ProviderFlow };
