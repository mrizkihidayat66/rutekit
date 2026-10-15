import type {
  ProviderAccountInsert,
  ProviderAccountRow,
  ProviderAccountsRepository,
} from '@server/persistence/provider-accounts.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import { emailFromIdToken, maskEmail } from './identity.ts';
import type { OauthToken } from './wire.ts';

/**
 * Where a finished sign-in lands (C3b2).
 *
 * Both flows end here, and neither of them gets to write a token in the clear:
 * the envelope is made before the row is, and the only part of the token that
 * survives outside it is the mask of an address. Keeping that in one function is
 * what makes the rule checkable — there is no second place a credential could be
 * stored from, so there is no second place to audit.
 *
 * A second sign-in for an address the provider already named replaces that
 * account's credential instead of adding a row. That is the whole reason the
 * masked address is kept: it is the identity a re-authorization can be matched
 * on, and without it every sign-in would leave another dead row behind.
 */

/**
 * The token as stored: what a later call needs to use it, and nothing more.
 *
 * Exported because `providers/credential.ts` is the read half of this pair — the
 * dispatcher has to put the access token in a header — and a second declaration
 * of the same five fields is a drift waiting to happen.
 */
export interface StoredCredential {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly tokenType: string | null;
  readonly scope: string | null;
  readonly expiresAt: string | null;
}

/** The two flows that produce a token; the manifest's other modes do not. */
export type OauthAuthMode = 'oauth-browser' | 'oauth-device';

export interface CredentialStoreDeps {
  readonly accounts: ProviderAccountsRepository;
  readonly now: () => number;
}

export interface CredentialStore {
  save(
    box: SecretBox,
    providerId: string,
    authMode: OauthAuthMode,
    token: OauthToken,
  ): ProviderAccountRow;
}

export function createCredentialStore(deps: CredentialStoreDeps): CredentialStore {
  function save(
    box: SecretBox,
    providerId: string,
    authMode: OauthAuthMode,
    token: OauthToken,
  ): ProviderAccountRow {
    const at = new Date(deps.now()).toISOString();
    const email = emailFromIdToken(token.idToken);
    const emailMasked = email === null ? null : maskEmail(email);
    const credentialEnvelope = box.encrypt(JSON.stringify(toStored(token)));

    const existing =
      emailMasked === null ? null : deps.accounts.findByProviderAndEmail(providerId, emailMasked);
    if (existing !== null) {
      deps.accounts.setCredential(existing.id, credentialEnvelope, at);
      return { ...existing, credentialEnvelope, updatedAt: at };
    }

    const row: ProviderAccountInsert = {
      id: crypto.randomUUID(),
      providerId,
      label: emailMasked ?? providerId,
      credentialEnvelope,
      authMode,
      emailMasked,
      // A sign-in proves the credential is fresh and says nothing about load, so
      // the account starts active with the pool's one-request default (C5).
      state: 'active',
      stateReason: null,
      maxInFlight: 1,
      note: null,
      createdAt: at,
      updatedAt: at,
    };
    // The pool's own columns — in-flight, cooldown, failures, quota — are left to
    // their schema defaults rather than restated here, so a new column does not
    // have to be remembered at every insert site.
    return deps.accounts.create(row);
  }

  return { save };
}

/** Drop the identity token: it was read for the address and has no later use. */
function toStored(token: OauthToken): StoredCredential {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenType: token.tokenType,
    scope: token.scope,
    expiresAt: token.expiresAt,
  };
}
