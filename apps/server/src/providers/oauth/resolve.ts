import { consolePath, consolePaths } from '@contracts';
import type { ProviderManifest } from '@registry';

import { AppError } from '@server/errors.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

/**
 * The parts of a sign-in that do not care which flow it is (C3b2).
 *
 * Both flows need the same four answers before they can begin: which sign-in
 * modes the provider declares, which client rutekit presents, where the provider
 * should send the browser back, and whether there is anywhere to put the result.
 * Keeping them here means the browser flow and the device flow cannot drift into
 * disagreeing about the redirect URI or the client id, which would be a bug that
 * only shows up against a real provider.
 */

export const NO_KEY_MESSAGE =
  'Provider sign-in needs an encryption key to store the credential under, and this instance has none configured.';

type AuthMode = ProviderManifest['authModes'][number];
/** Either sign-in that ends in a token; the manifest's other modes do not. */
export type OauthAuth = Extract<AuthMode, { mode: 'oauth-browser' | 'oauth-device' }>;
export type BrowserAuth = Extract<AuthMode, { mode: 'oauth-browser' }>;
export type DeviceAuth = Extract<AuthMode, { mode: 'oauth-device' }>;

export function requireSecrets(secrets: SecretBox | null): SecretBox {
  if (secrets === null) throw AppError.unavailable(NO_KEY_MESSAGE);
  return secrets;
}

/** The provider's sign-in mode, or null when it has none to speak of. */
export function oauthAuth(manifest: ProviderManifest): OauthAuth | null {
  for (const mode of manifest.authModes) {
    if (mode.mode === 'oauth-browser' || mode.mode === 'oauth-device') return mode;
  }
  return null;
}

/**
 * The client rutekit presents. The environment wins over the manifest because a
 * provider can revoke the registration a release shipped with, and an operator
 * holding their own registration should not have to wait for the next one.
 */
export function clientFor(
  env: Readonly<Record<string, string | undefined>>,
  providerId: string,
  fallbackId: string,
  fallbackSecret: string | null,
): { clientId: string; clientSecret: string | null } {
  const prefix = `RUTEKIT_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_OAUTH_`;
  return {
    clientId: env[`${prefix}CLIENT_ID`] ?? fallbackId,
    clientSecret: env[`${prefix}CLIENT_SECRET`] ?? fallbackSecret,
  };
}

/**
 * The one URI rutekit serves. The manifest states it because the provider was
 * registered with it, and the route states it because the route exists — so a
 * manifest that disagrees fails at the start, rather than sending the browser to
 * a path nothing answers.
 */
export function redirectUri(consoleOrigin: string, providerId: string): string {
  return `${consoleOrigin}${consolePath(consolePaths.providerOauthCallback, { id: providerId })}`;
}

/** The path half of `redirectUri`, which is what a manifest registers. */
export function redirectPath(providerId: string): string {
  return consolePath(consolePaths.providerOauthCallback, { id: providerId });
}
