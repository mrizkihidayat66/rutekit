import type { ModelSource, ProviderModel, ProviderTestResult } from '@contracts';

import { classifyFailure } from './classify.ts';
import { parseListing, type ListedModel } from './listing.ts';
import type { Discovery } from './manifest/discovery.ts';
import type { ManifestModel, ProviderManifest } from './manifest.ts';
import { applyAuth, endpointUrl, withQuery, type Fetcher, type HttpResponse } from './transport.ts';

/**
 * Asking a provider two questions: which models do you serve, and are you there.
 *
 * Both answer rather than throw. A probe that rejects forces every caller to wrap
 * it, and the wrapping is always the same — turn the rejection into the sentence
 * the console shows — so the sentence is produced here instead. The one thing a
 * caller has to supply is the `fetch`, which is what keeps a test from needing a
 * socket.
 */

export interface ProbeOptions {
  readonly fetch: Fetcher;
  /** The account's credential, already decrypted; null for a provider with none. */
  readonly credential?: string | null;
  /** Values for a `baseUrlTemplate`'s placeholders, e.g. region and project. */
  readonly values?: Readonly<Record<string, string>>;
  /** Clock in epoch milliseconds, injectable so latency can be asserted. */
  readonly now?: () => number;
}

/** What a model listing turned out to be, and why it might be empty. */
export interface ModelDiscovery {
  readonly models: readonly ProviderModel[];
  /** `template` when the list came from the manifest, `synced` from the endpoint. */
  readonly source: ModelSource;
  /** Non-null when the endpoint was asked and its answer could not be used. */
  readonly problem: string | null;
}

const DEFAULT_LISTING_PATH: Readonly<Record<'openai' | 'anthropic' | 'google', string>> = {
  openai: '/models',
  anthropic: '/models',
  google: '/models',
};

const NO_FLAGS = { vision: false, tools: false, reasoning: false, embedding: false };

/**
 * The path a provider's model list lives at, or null when there is nothing to
 * list.
 *
 * Exported because the warmup check-in asks the same question this module does —
 * "what is the cheapest authenticated GET for this provider?" — and answering it
 * two ways is how the probe and the listing drift apart.
 */
export function listingPath(discovery: Discovery): string | null {
  if (discovery.strategy === 'static') return null;
  return discovery.path ?? DEFAULT_LISTING_PATH[discovery.strategy];
}

/**
 * The path a health probe asks, which is not always the listing path.
 *
 * A provider that lists its models can be probed by listing them, so that is
 * tried first. One that cannot — `static`, whose models are curated — still has
 * to answer *something* if its accounts are ever going to leave `pending`, and
 * `probePath` is where it says what. Null when there is genuinely nothing to ask,
 * which is a local runner with no remote endpoint.
 */
export function probePath(discovery: Discovery): string | null {
  return listingPath(discovery) ?? discovery.probePath;
}

function toProviderModel(
  manifest: ProviderManifest,
  model: ManifestModel,
  source: ModelSource,
): ProviderModel {
  return {
    id: model.id,
    providerId: manifest.id,
    displayName: model.displayName === '' ? model.id : model.displayName,
    source,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: { ...model.capabilities },
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    deprecated: model.deprecated,
  };
}

/**
 * An id the endpoint listed, described with everything the manifest already knew
 * about it.
 *
 * A listing says what exists, not what it costs or what it can do, so an id
 * rutekit curates keeps the manifest's capabilities and prices while an id it has
 * never seen arrives with nothing but its name. The alternative — trusting the
 * wire for capabilities — would have every synced model lose its prices the first
 * time the endpoint was asked.
 */
function fromListing(manifest: ProviderManifest, listed: ListedModel): ProviderModel {
  const curated = manifest.models.find((model) => model.id === listed.id);
  const curatedName = curated?.displayName ?? '';
  const name = listed.displayName ?? (curatedName === '' ? listed.id : curatedName);

  return {
    id: listed.id,
    providerId: manifest.id,
    displayName: name,
    source: 'synced',
    contextWindow: listed.contextWindow ?? curated?.contextWindow ?? null,
    maxOutputTokens: listed.maxOutputTokens ?? curated?.maxOutputTokens ?? null,
    capabilities: curated === undefined ? { ...NO_FLAGS } : { ...curated.capabilities },
    inputPricePerMTok: curated?.inputPricePerMTok ?? null,
    outputPricePerMTok: curated?.outputPricePerMTok ?? null,
    deprecated: curated?.deprecated ?? false,
  };
}

async function readBody(response: HttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * The models a provider serves.
 *
 * A `static` provider is not asked anything: a local runner has no catalogue to
 * request and a short fixed list is already in the manifest, so the curated list
 * is the answer and its source says so. Every other strategy calls the endpoint,
 * and every way that can go wrong — no credential, an unreachable host, a refusal
 * rutekit can name, a body it cannot read — ends as an empty list and a sentence
 * rather than a rejection.
 */
export async function listModels(
  manifest: ProviderManifest,
  options: ProbeOptions,
): Promise<ModelDiscovery> {
  const discovery = manifest.discovery;

  if (discovery.strategy === 'static') {
    return {
      models: manifest.models.map((model) => toProviderModel(manifest, model, 'template')),
      source: 'template',
      problem: null,
    };
  }

  const credential = options.credential ?? null;
  if (discovery.requiresCredential && credential === null) {
    return {
      models: [],
      source: 'synced',
      problem: 'This provider needs a credential before its models can be listed.',
    };
  }

  const target = endpointUrl(manifest, listingPath(discovery), options.values ?? {});
  if (target.missing.length > 0) {
    return {
      models: [],
      source: 'synced',
      problem: `The endpoint needs ${target.missing.join(', ')} before it can be reached.`,
    };
  }

  const auth = applyAuth(manifest, credential);
  const url = Object.keys(auth.query).length === 0 ? target.url : withQuery(target.url, auth.query);

  let response: HttpResponse;
  try {
    response = await options.fetch(url, { method: 'GET', headers: auth.headers });
  } catch (error) {
    return {
      models: [],
      source: 'synced',
      problem: `Could not reach the endpoint: ${message(error)}`,
    };
  }

  const body = await readBody(response);
  if (response.status >= 400) {
    const failure = classifyFailure(manifest, { status: response.status, body });
    return {
      models: [],
      source: 'synced',
      problem:
        failure === null
          ? `The endpoint answered HTTP ${response.status}.`
          : `The endpoint refused the request (${failure.class}, HTTP ${response.status}).`,
    };
  }

  const listed = parseListing(discovery.strategy, body);
  if (listed === null) {
    return {
      models: [],
      source: 'synced',
      problem: 'The endpoint answered, but its model list could not be read.',
    };
  }

  return {
    models: listed.map((entry) => fromListing(manifest, entry)),
    source: 'synced',
    problem: null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'an unknown error';
}

/**
 * Whether a provider can be reached with the credential in hand.
 *
 * A `static` provider is probed too, at its base URL rather than at a listing:
 * a local runner has nothing to list, but whether it is running is exactly the
 * question the console's button is asking. `modelCount` stays null there because
 * nothing was asked, which is a different answer from zero.
 */
export async function testConnection(
  manifest: ProviderManifest,
  options: ProbeOptions,
): Promise<ProviderTestResult> {
  const clock = options.now ?? (() => Date.now());
  const started = clock();
  const checkedAt = new Date(started).toISOString();
  const credential = options.credential ?? null;
  const discovery = manifest.discovery;

  const target = endpointUrl(manifest, listingPath(discovery), options.values ?? {});
  if (target.missing.length > 0) {
    return {
      ok: false,
      latencyMs: null,
      modelCount: null,
      checkedAt,
      message: `The endpoint needs ${target.missing.join(', ')} before it can be reached.`,
    };
  }

  if (discovery.requiresCredential && credential === null) {
    return {
      ok: false,
      latencyMs: null,
      modelCount: null,
      checkedAt,
      message: 'Add a credential before testing this provider.',
    };
  }

  const auth = applyAuth(manifest, credential);
  const url = Object.keys(auth.query).length === 0 ? target.url : withQuery(target.url, auth.query);

  try {
    const response = await options.fetch(url, { method: 'GET', headers: auth.headers });
    const body = await readBody(response);
    const latencyMs = Math.max(0, clock() - started);

    if (response.status >= 400) {
      const failure = classifyFailure(manifest, { status: response.status, body });
      return {
        ok: false,
        latencyMs,
        modelCount: null,
        checkedAt,
        message:
          failure === null
            ? `The endpoint answered HTTP ${response.status}.`
            : `The endpoint answered HTTP ${response.status} (${failure.class}).`,
      };
    }

    if (discovery.strategy === 'static') {
      return {
        ok: true,
        latencyMs,
        modelCount: null,
        checkedAt,
        message: 'The endpoint answered.',
      };
    }

    const listed = parseListing(discovery.strategy, body);
    if (listed === null) {
      return {
        ok: false,
        latencyMs,
        modelCount: null,
        checkedAt,
        message: 'The endpoint answered, but its model list could not be read.',
      };
    }

    return {
      ok: true,
      latencyMs,
      modelCount: listed.length,
      checkedAt,
      message: `Reachable; listed ${listed.length} model(s).`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      modelCount: null,
      checkedAt,
      message: `Could not reach the endpoint: ${message(error)}`,
    };
  }
}
