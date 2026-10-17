import { z } from 'zod';

/**
 * A pasted key. The header and the scheme are the provider's, not ours: most
 * take `Authorization: Bearer <key>`, Anthropic takes `x-api-key: <key>` with no
 * scheme at all, and Google takes the key as a `key` query parameter. `scheme`
 * and `queryParam` are both nullable because a provider uses one or the other,
 * and a value of null is how a manifest says "raw".
 */
export const apiKeyAuthSchema = z.object({
  mode: z.literal('api-key'),
  header: z.string().min(1),
  scheme: z.string().min(1).nullable().default(null),
  queryParam: z.string().min(1).nullable().default(null),
});

/**
 * A pasted session cookie.
 *
 * Not a lesser API key: what is pasted is a browser session, it expires on the
 * provider's own schedule, it can be revoked by signing out, and there is no
 * refresh — the operator pastes a new one. Keeping it a distinct mode is what
 * lets the console say that, instead of labelling a session as a key.
 */
export const cookieAuthSchema = z.object({
  mode: z.literal('cookie'),
  /** The cookie the operator is asked for, e.g. `sso`. */
  cookieName: z.string().min(1),
  header: z.string().min(1).default('Cookie'),
});

/**
 * A sign-in the operator completes in a browser, on the provider's page.
 *
 * rutekit never sees the password: it sends the operator to `authorizeUrl` and
 * the provider redirects back to `redirectPath` on rutekit's own origin. PKCE is
 * on by default and off only for the providers that predate it.
 *
 * `clientId` is rutekit's registration with the provider, so it belongs to the
 * manifest rather than to the operator — but a provider can revoke or rotate it,
 * which is why the server reads `RUTEKIT_<PROVIDER>_OAUTH_CLIENT_ID` (and the
 * secret beside it) first and falls back to these values. `clientSecret` is null
 * for the public clients that authenticate with PKCE alone.
 */
export const oauthBrowserAuthSchema = z.object({
  mode: z.literal('oauth-browser'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).nullable().default(null),
  authorizeUrl: z.url(),
  tokenUrl: z.url(),
  /** Where an expired access token is renewed; null means `tokenUrl`. */
  refreshUrl: z.url().nullable().default(null),
  scopes: z.array(z.string().min(1)).default([]),
  redirectPath: z.string().min(1),
  usePkce: z.boolean().default(true),
  /** Static parameters the provider requires on the authorize request. */
  extraParams: z.record(z.string(), z.string()).default({}),
  /**
   * Which field of the stored credential carries the bearer token.
   *
   * **Not every provider calls it `accessToken`.** qoder's envelope names its
   * session token `securityOauthToken`, and a reader that looked only for the
   * conventional name fell back to the whole JSON document — so the probe sent
   * `Authorization: Bearer {"personalToken":…}` and was refused, while the chat
   * path never noticed because its codec writes its own signed header.
   *
   * The default is the OAuth convention, so only a provider that departs from it
   * says anything here.
   */
  credentialField: z.string().min(1).default('accessToken'),
});

/**
 * A sign-in the operator completes by opening a URL and typing a short code.
 *
 * The flow that works where a browser redirect cannot reach — a headless host, a
 * container. There is no redirect path because there is no redirect, and no
 * secret because a device flow is by definition a public client: the device code
 * is what stands in for a credential until the operator approves it.
 */
export const oauthDeviceAuthSchema = z.object({
  mode: z.literal('oauth-device'),
  clientId: z.string().min(1),
  deviceCodeUrl: z.url(),
  tokenUrl: z.url(),
  scopes: z.array(z.string().min(1)).default([]),
  /** See `oauthBrowserAuthSchema.credentialField`. */
  credentialField: z.string().min(1).default('accessToken'),
});

/**
 * A service account that signs its own tokens.
 *
 * The credential is a private key, and the access token is minted from it rather
 * than refreshed from a stored secret. Vertex is the case in the v1 catalog.
 */
export const serviceAccountAuthSchema = z.object({
  mode: z.literal('service-account'),
  tokenUrl: z.url(),
  scopes: z.array(z.string().min(1)).default([]),
});

/**
 * How rutekit proves to a provider that it may call it.
 *
 * A discriminated union rather than a bag of optional flags: the modes need
 * different fields, and a half-filled OAuth block must fail to parse rather than
 * load as an API key with an unused authorize URL. `none` is a real mode, not a
 * missing one — a public endpoint has nothing to paste and no sign-in to run.
 */
export const authSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  apiKeyAuthSchema,
  cookieAuthSchema,
  oauthBrowserAuthSchema,
  oauthDeviceAuthSchema,
  serviceAccountAuthSchema,
]);

export type Auth = z.infer<typeof authSchema>;
export type AuthMode = Auth['mode'];
