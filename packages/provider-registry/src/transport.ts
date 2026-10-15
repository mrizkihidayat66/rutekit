import type { Auth } from './manifest/auth.ts';
import type { ProviderManifest } from './manifest.ts';

/**
 * Everything the registry needs from the network, stated as the smallest possible
 * surface.
 *
 * `fetch` is not reached for as a global. The package's tsconfig declares no
 * ambient types at all, and that is deliberate: a module that grabs a global
 * cannot be exercised without a runtime standing behind it, and the interesting
 * behaviour here — what a 429 means, what an unreadable list degrades to — is
 * exactly the behaviour a test wants to drive. So the caller passes the function
 * in, and the tests pass in a fake.
 *
 * The two request/response types below are structural rather than the platform's
 * own, for the same reason: nothing in this package names a DOM or Node type.
 */

/** The part of a response the registry reads. */
export interface HttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

/**
 * The part of a request the registry sets.
 *
 * `body` is here for the OAuth token calls (C3b2), which are form-encoded POSTs
 * and the only place this package sends one. It stays optional and stays a
 * string: a manifest-driven GET never sets it, and a caller that passes a
 * `URLSearchParams` would be handing the transport a type it has no reason to
 * know.
 */
export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type Fetcher = (url: string, init: HttpRequest) => Promise<HttpResponse>;

/** A URL, plus whatever the template still wanted. */
export interface EndpointTarget {
  readonly url: string;
  /** Placeholder names the caller did not supply; non-empty means unreachable. */
  readonly missing: readonly string[];
}

/** Where a credential ends up once the manifest's auth mode has had its say. */
export interface AuthApplication {
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
}

const PLACEHOLDER = /\{([^}]+)\}/gu;

function joinPath(base: string, path: string | null): string {
  if (path === null || path === '') return base;
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  const right = path.startsWith('/') ? path : `/${path}`;
  return `${left}${right}`;
}

/** Append parameters, keeping any the URL already carries. */
export function withQuery(url: string, params: Readonly<Record<string, string>>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return url;
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/**
 * Substitute an account's values into a template, collecting what is missing
 * rather than failing on the first gap — an operator who has to be told twice
 * which fields are unset has been told badly.
 */
export function resolveTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): { url: string; missing: string[] } {
  const missing = new Set<string>();
  const url = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') {
      missing.add(name);
      return '';
    }
    return value;
  });
  return { url, missing: [...missing] };
}

/**
 * The URL to call, assembled from the manifest and the account.
 *
 * A literal `baseUrl` is used as written; a `baseUrlTemplate` is resolved against
 * the account's values. Static query parameters follow, and a region that travels
 * as a query parameter is appended here rather than by the caller, because the
 * manifest is what knows where the provider wants it.
 */
export function endpointUrl(
  manifest: ProviderManifest,
  path: string | null,
  values: Readonly<Record<string, string>> = {},
): EndpointTarget {
  const endpoint = manifest.endpoint;
  const resolved =
    endpoint.baseUrl !== null
      ? { url: endpoint.baseUrl, missing: [] as string[] }
      : resolveTemplate(endpoint.baseUrlTemplate ?? '', values);

  const query: Record<string, string> = { ...endpoint.queryParams };
  if (
    endpoint.regions !== null &&
    endpoint.regions.placement === 'query' &&
    endpoint.regions.param !== null
  ) {
    query[endpoint.regions.param] = values['region'] ?? endpoint.regions.default;
  }

  return { url: withQuery(joinPath(resolved.url, path), query), missing: resolved.missing };
}

/**
 * Apply the manifest's first auth mode to a credential.
 *
 * Only the first mode is applied. The list is the console's preference order, and
 * a probe has one credential in hand rather than a set, so the mode the console
 * would have offered first is the mode that credential belongs to.
 */
export function applyAuth(manifest: ProviderManifest, credential: string | null): AuthApplication {
  const auth: Auth | undefined = manifest.authModes[0];
  if (auth === undefined || auth.mode === 'none' || credential === null) {
    return { headers: {}, query: {} };
  }

  switch (auth.mode) {
    case 'api-key':
      if (auth.queryParam !== null)
        return { headers: {}, query: { [auth.queryParam]: credential } };
      return {
        headers: {
          [auth.header]: auth.scheme === null ? credential : `${auth.scheme} ${credential}`,
        },
        query: {},
      };
    case 'cookie':
      return { headers: { [auth.header]: `${auth.cookieName}=${credential}` }, query: {} };
    case 'oauth-browser':
    case 'oauth-device':
    case 'service-account':
      return { headers: { Authorization: `Bearer ${credential}` }, query: {} };
  }
}
