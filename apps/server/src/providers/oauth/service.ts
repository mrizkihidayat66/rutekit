import type { ProviderOauthResult } from '@contracts';
import type { Logger } from 'pino';
import type { Fetcher, ProviderManifest, ProviderRegistry } from '@registry';

import { AppError } from '@server/errors.ts';
import type {
  ProviderAccountRow,
  ProviderAccountsRepository,
} from '@server/persistence/provider-accounts.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import { createBrowserFlow, type BrowserFlow } from './browser.ts';
import { createDeviceSessions, type DeviceSessions } from './device-session.ts';
import { startDeviceFlow } from './device.ts';
import type { PendingFlows } from './pending.ts';
import { clientFor, oauthAuth, requireSecrets, type DeviceAuth } from './resolve.ts';
import { createCredentialStore } from './store.ts';
import type { FlowResult } from './wire.ts';

/**
 * The sign-in, as the console sees it (C3b2).
 *
 * Two flows behind one contract: the console asks rutekit to start a sign-in and
 * is told either that one began — with a URL to open — or why it could not. From
 * there they part company. The browser flow ends inside the callback request,
 * where `complete` trades the code; the device flow ends on a timer, because the
 * operator is on a machine rutekit cannot redirect.
 *
 * Both end in the same place: an encrypted envelope in `provider_accounts`, which
 * is the one thing this module hands to `store.ts` and never sees again. The
 * plaintext token never leaves that pair of files, and the only thing that can be
 * read back about the account is a masked address.
 *
 * The two kinds of failure are kept apart. What a caller could have avoided — an
 * unknown provider, a provider with no sign-in, no encryption key to store under
 * — is thrown, because the console should not have offered the button. What the
 * network decided is returned, because a refusal from a provider is an answer
 * rather than a bug.
 */

export interface ProviderOauthServiceDeps {
  readonly registry: ProviderRegistry;
  readonly accounts: ProviderAccountsRepository;
  /** Null when no encryption key is configured, which makes a sign-in pointless. */
  readonly secrets: SecretBox | null;
  readonly pending: PendingFlows;
  readonly logger: Logger;
  /** rutekit's own origin, as the provider must see it in the redirect URI. */
  readonly consoleOrigin: string;
  readonly fetch: Fetcher;
  /** Read for the per-provider client overrides; `process.env` in production. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly sessions?: DeviceSessions;
}

export interface ProviderOauthService {
  start(providerId: string): Promise<ProviderOauthResult>;
  complete(
    providerId: string,
    code: string,
    state: string,
  ): Promise<FlowResult<ProviderAccountRow>>;
  /** Abandon every device poll still running. Called on shutdown. */
  stop(): void;
}

export function createProviderOauthService(deps: ProviderOauthServiceDeps): ProviderOauthService {
  const now = deps.now ?? ((): number => Date.now());
  const env = deps.env ?? {};
  const sessions = deps.sessions ?? createDeviceSessions();
  const store = createCredentialStore({ accounts: deps.accounts, now });

  const browser: BrowserFlow = createBrowserFlow({
    registry: deps.registry,
    pending: deps.pending,
    secrets: deps.secrets,
    fetch: deps.fetch,
    now,
    env,
    consoleOrigin: deps.consoleOrigin,
    store,
  });

  async function startDevice(
    manifest: ProviderManifest,
    auth: DeviceAuth,
    box: SecretBox,
  ): Promise<ProviderOauthResult> {
    const { clientId } = clientFor(env, manifest.id, auth.clientId, null);
    const started = await startDeviceFlow({
      deviceCodeUrl: auth.deviceCodeUrl,
      clientId,
      scopes: auth.scopes,
      fetch: deps.fetch,
      now,
    });
    if (!started.ok) return { started: false, authorizeUrl: null, message: started.message };

    const authorization = started.value;
    sessions.start({
      providerId: manifest.id,
      tokenUrl: auth.tokenUrl,
      clientId,
      deviceCode: authorization.deviceCode,
      intervalSeconds: authorization.intervalSeconds,
      expiresAtMs: authorization.expiresAtMs,
      fetch: deps.fetch,
      now,
      onToken: (token) => {
        store.save(box, manifest.id, 'oauth-device', token);
      },
      onFailure: (message) => {
        // The console has no endpoint to be told on — the contract starts a flow
        // and never asks about one — so the log is the only place this can land.
        deps.logger.warn({ providerId: manifest.id, message }, 'device sign-in did not finish');
      },
    });

    return {
      started: true,
      authorizeUrl: authorization.verificationUri,
      message: `Enter the code ${authorization.userCode} at ${authorization.verificationUri}. The credential lands here once it is approved.`,
    };
  }

  async function start(providerId: string): Promise<ProviderOauthResult> {
    const manifest = deps.registry.get(providerId);
    if (manifest === undefined) throw AppError.notFound(`No provider with id ${providerId}.`);

    const auth = oauthAuth(manifest);
    if (auth === null) throw AppError.invalidRequest(`${manifest.name} does not sign in over OAuth.`);

    const box = requireSecrets(deps.secrets);
    switch (auth.mode) {
      case 'oauth-browser':
        return browser.start(manifest, auth);
      case 'oauth-device':
        return await startDevice(manifest, auth, box);
    }
  }

  return {
    start,
    // Wrapped rather than passed by reference: the flow is an object of methods,
    // and handing one out on its own would detach it from the store it closes over.
    complete: (providerId, code, state) => browser.complete(providerId, code, state),
    stop(): void {
      sessions.stopAll();
    },
  };
}
