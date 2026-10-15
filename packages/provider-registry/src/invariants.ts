import type { AuthMode } from './manifest/auth.ts';
import type { ProviderManifest } from './manifest.ts';

/**
 * The rules a manifest cannot state about itself.
 *
 * A schema sees one field at a time, so it can say that `baseUrl` is a URL and
 * that `baseUrlTemplate` is a string, but not that a provider must have exactly
 * one of the two, nor that an `oauth` capability has to agree with the auth modes
 * beside it. Those pairings live here.
 *
 * Every check collects a message rather than throwing, so one broken manifest
 * reports all of its problems in a single pass instead of one problem per edit.
 * The registry runs the lot over the whole catalogue at construction, which is
 * what turns a contradiction into a refusal to boot rather than a failure on
 * whichever request happens to reach that provider first.
 */

/** A cross-field contradiction in one manifest. */
export interface ManifestIssue {
  providerId: string;
  /** Dotted path to the field at fault, for an error message that points. */
  field: string;
  message: string;
}

/** The modes that mean "an operator signs in", as opposed to pasting something. */
const SIGN_IN_MODES: readonly AuthMode[] = ['oauth-browser', 'oauth-device', 'service-account'];

/**
 * A sign-in is one the operator performs; a pasted key or cookie is not. Vertex
 * counts as a sign-in even though its mode is `service-account`, because the
 * account is established by an authorization the operator set up out of band —
 * which is what the capability flag is claiming.
 */
const signsIn = (mode: AuthMode): boolean => SIGN_IN_MODES.includes(mode);

export function checkManifest(manifest: ProviderManifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const add = (field: string, message: string): void => {
    issues.push({ providerId: manifest.id, field, message });
  };

  checkEndpoint(manifest, add);
  checkAuth(manifest, add);
  checkQuota(manifest, add);
  checkAutomation(manifest, add);

  const modelIds = new Set<string>();
  for (const model of manifest.models) {
    if (modelIds.has(model.id)) add('models', `lists ${model.id} more than once`);
    modelIds.add(model.id);
  }

  return issues;
}

type Add = (field: string, message: string) => void;

function checkEndpoint(manifest: ProviderManifest, add: Add): void {
  const { baseUrl, baseUrlTemplate, regions } = manifest.endpoint;

  // Exactly one URL form: a literal endpoint, or one an account assembles.
  if (baseUrl === null && baseUrlTemplate === null) {
    add('endpoint', 'needs a baseUrl or a baseUrlTemplate');
  }
  if (baseUrl !== null && baseUrlTemplate !== null) {
    add('endpoint', 'has both a baseUrl and a baseUrlTemplate; keep one');
  }
  if (baseUrlTemplate !== null && !baseUrlTemplate.includes('{')) {
    add('endpoint.baseUrlTemplate', 'has no {placeholder} for an account to resolve');
  }

  if (regions === null) return;

  if (!regions.values.includes(regions.default)) {
    add('endpoint.regions.default', `is not one of: ${regions.values.join(', ')}`);
  }

  if (regions.placement === 'host') {
    if (regions.param !== null) {
      add('endpoint.regions.param', 'is set for a region that sits in the host');
    }
    if (baseUrlTemplate === null) {
      add('endpoint.regions', 'places the region in the host, which needs a baseUrlTemplate');
    }
    return;
  }

  if (regions.param === null) {
    add('endpoint.regions.param', `is required when the region travels as a ${regions.placement}`);
  }
}

function checkAuth(manifest: ProviderManifest, add: Add): void {
  const modes = manifest.authModes.map((auth) => auth.mode);

  if (new Set(modes).size !== modes.length) {
    add('authModes', 'declares the same mode more than once');
  }

  const hasSignIn = modes.some(signsIn);
  if (manifest.capabilities.oauth !== hasSignIn) {
    add(
      'capabilities.oauth',
      hasSignIn
        ? 'is false, but the provider declares a sign-in'
        : 'is true, but no auth mode is a sign-in',
    );
  }

  // `free` is defined as "no credential": a public endpoint has nothing to paste.
  if (manifest.category === 'free' && modes.some((mode) => mode !== 'none')) {
    add('category', 'is `free`, which means a public endpoint, but a credential is declared');
  }
  if (manifest.category === 'oauth' && !manifest.capabilities.oauth) {
    add('category', 'is `oauth` while the oauth capability is false');
  }
}

function checkQuota(manifest: ProviderManifest, add: Add): void {
  const { quota } = manifest;

  if (manifest.capabilities.quota !== (quota.kind !== 'none')) {
    add(
      'capabilities.quota',
      quota.kind === 'none'
        ? 'is true, but the quota policy is `none`'
        : 'is false, but a quota policy is declared',
    );
  }

  if (quota.kind === 'none') return;

  if (quota.source === 'endpoint' && quota.path === null) {
    add('quota.path', 'is required when the numbers come from an endpoint');
  }
  if (quota.source === 'headers' && quota.path !== null) {
    add('quota.path', 'is set, but the numbers come from headers');
  }
}

/**
 * The capability is a claim that rutekit can create an account here by itself, so
 * a declared flow and the flag have to arrive together. ADR-0006's rule again:
 * a provider whose automation is not written yet says `false` and has no flow,
 * rather than promising one the runner cannot perform.
 */
function checkAutomation(manifest: ProviderManifest, add: Add): void {
  const declared = manifest.automation !== null;
  if (manifest.capabilities.automation !== declared) {
    add(
      'capabilities.automation',
      declared
        ? 'is false, but the manifest declares an automation flow'
        : 'is true, but no automation flow is declared',
    );
  }
}
