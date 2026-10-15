import type { ProviderOauthResult } from '@contracts';
import type { Fetcher, ProviderManifest, ProviderRegistry } from '@registry';

import { AppError } from '@server/errors.ts';
import type { ProviderAccountRow } from '@server/persistence/provider-accounts.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import { buildAuthorizeUrl, exchangeCode } from './flow.ts';
import type { PendingFlows } from './pending.ts';
import { codeChallengeS256, createCodeVerifier, createState } from './pkce.ts';
import {
  clientFor,
  NO_KEY_MESSAGE,
  oauthAuth,
  redirectPath,
  redirectUri,
  type BrowserAuth,
} from './resolve.ts';
import type { CredentialStore } from './store.ts';
import { failed, type FlowResult } from './wire.ts';

/**
 * The browser redirect, from the first request to the last (C3b2).
 *
 * This is the flow that has somewhere to come back to. `start` mints a state and
 * a PKCE verifier, remembers them against that state, and hands back the URL to
 * open; the provider then sends the browser to rutekit's callback, and `complete`
 * finds the flow by its state and trades the code. Nothing survives the callback
 * — the pending flow is taken, not read — so a state cannot be replayed.
 *
 * The two halves live together because they are one flow: the redirect URI the
 * authorize URL names is the one the exchange must send, and the verifier minted
 * in the first half is the one presented in the second. Split them and each half
 * would need the other's invariants restated, which is how they drift apart.
 */

export interface BrowserFlowDeps {
  readonly registry: ProviderRegistry;
  readonly pending: PendingFlows;
  readonly secrets: SecretBox | null;
  readonly fetch: Fetcher;
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** rutekit's own origin, as the provider must see it in the redirect URI. */
  readonly consoleOrigin: string;
  readonly store: CredentialStore;
}

export interface BrowserFlow {
  start(manifest: ProviderManifest, auth: BrowserAuth): ProviderOauthResult;
  complete(
    providerId: string,
    code: string,
    state: string,
  ): Promise<FlowResult<ProviderAccountRow>>;
}

export function createBrowserFlow(deps: BrowserFlowDeps): BrowserFlow {
  function start(manifest: ProviderManifest, auth: BrowserAuth): ProviderOauthResult {
    const expected = redirectPath(manifest.id);
    if (auth.redirectPath !== expected) {
      throw AppError.invalidRequest(
        `${manifest.name} registers a redirect path rutekit does not serve (${auth.redirectPath}).`,
      );
    }

    const redirect = redirectUri(deps.consoleOrigin, manifest.id);
    const state = createState();
    const verifier = auth.usePkce ? createCodeVerifier() : null;
    deps.pending.put(state, {
      providerId: manifest.id,
      codeVerifier: verifier,
      redirectUri: redirect,
      createdAtMs: deps.now(),
    });

    const { clientId } = clientFor(deps.env, manifest.id, auth.clientId, null);
    return {
      started: true,
      authorizeUrl: buildAuthorizeUrl({
        authorizeUrl: auth.authorizeUrl,
        clientId,
        redirectUri: redirect,
        scopes: auth.scopes,
        state,
        codeChallenge: verifier === null ? null : codeChallengeS256(verifier),
        extraParams: auth.extraParams,
      }),
      message: `Opened a sign-in for ${manifest.name}. Finish it in the browser tab and the credential lands here on its own.`,
    };
  }

  async function complete(
    providerId: string,
    code: string,
    state: string,
  ): Promise<FlowResult<ProviderAccountRow>> {
    const flow = deps.pending.take(state, deps.now());
    if (flow === null) return failed('That sign-in has expired, or it was already completed.');
    if (flow.providerId !== providerId) {
      return failed('That sign-in was started for a different provider.');
    }

    const manifest = deps.registry.get(providerId);
    if (manifest === undefined) return failed(`No provider with id ${providerId}.`);

    const auth = oauthAuth(manifest);
    if (auth === null || auth.mode !== 'oauth-browser') {
      return failed(`${manifest.name} does not sign in through a browser redirect.`);
    }

    const box = deps.secrets;
    if (box === null) return failed(NO_KEY_MESSAGE);

    const client = clientFor(deps.env, providerId, auth.clientId, auth.clientSecret);
    const exchanged = await exchangeCode({
      tokenUrl: auth.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
      fetch: deps.fetch,
      now: deps.now,
    });
    if (!exchanged.ok) return failed(exchanged.message);

    return { ok: true, value: deps.store.save(box, providerId, 'oauth-browser', exchanged.value) };
  }

  return { start, complete };
}
