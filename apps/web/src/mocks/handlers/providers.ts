import { HttpResponse } from 'msw';

import { http } from '../net.ts';
import type { Account, Provider, ProviderModel, ProviderTestResult } from '@contracts';
import {
  accountInputSchema,
  accountSchema,
  accountUpdateSchema,
  accountsResponseSchema,
  bulkAccountActionSchema,
  bulkResultSchema,
  modelCatalogResponseSchema,
  providerDetailSchema,
  providerInputSchema,
  providerModelInputSchema,
  providerModelSchema,
  providerModelsResponseSchema,
  providerOauthResultSchema,
  providerSchema,
  providerTestResultSchema,
  providerUpdateSchema,
  providersResponseSchema,
  quotaCheckBodySchema,
  quotaOverviewSchema,
} from '@contracts';

import { db, matches, paginate, sortBy } from '../db.ts';
import { isoAt } from '../clock.ts';
import { synthesizeModels } from '../fixtures/providers.ts';
import {
  badRequest,
  bodyOf,
  conflict,
  listParams,
  notFound,
  numParam,
  ok,
  paramId,
  paramOf,
  respond,
  route,
  searchParams,
  slugify,
  strParam,
  uid,
} from './helpers.ts';

/** Providers section: Provider Catalog, Provider Detail, Accounts, Quota. */

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

export const providerHandlers = [
  http.get(route('providers'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const category = strParam(params, 'category');
    const status = strParam(params, 'status');
    const tier = params.get('tier') ?? 'all';
    const q = params.get('q') ?? '';

    let items = db.providers;
    if (category !== null) items = items.filter((entry) => entry.category === category);
    if (status !== null) items = items.filter((entry) => entry.status === status);
    if (tier === 'free') items = items.filter((entry) => entry.freeTier);
    if (tier === 'paid') items = items.filter((entry) => !entry.freeTier);
    items = items.filter((entry) => matches([entry.name, entry.description, entry.id], q));

    return respond(
      providersResponseSchema,
      paginate(sortBy(items, sort, direction), { cursor, limit }),
    );
  }),

  http.post(route('providers'), async ({ request }) => {
    const input = providerInputSchema.parse(await bodyOf(request));
    const base = slugify(input.name);
    const id = db.provider(base) === undefined ? base : `${base}-${uid('p').slice(2, 6)}`;
    const provider: Provider = {
      id,
      name: input.name,
      description: input.description,
      category: input.category,
      status:
        input.apiKey !== null || input.category === 'local' || input.category === 'free'
          ? 'ready'
          : 'needs_auth',
      icon: input.icon,
      baseUrl: input.baseUrl,
      wireFamily: input.wireFamily,
      docsUrl: input.docsUrl,
      freeTier: false,
      capabilities: {
        quota: false,
        oauth: false,
        automation: false,
        streaming: true,
        vision: false,
        tools: true,
      },
      modelCount: 0,
      accountCount: 0,
      activeAccountCount: 0,
      createdAt: isoAt(0),
      updatedAt: isoAt(0),
    };
    db.providers.push(provider);
    return respond(providerSchema, provider);
  }),

  http.get(route('provider'), ({ params }) => {
    const provider = db.provider(paramId(params));
    if (provider === undefined) return notFound('provider', paramId(params));
    return respond(providerDetailSchema, {
      provider,
      models: db.modelsOf(provider.id),
      accounts: db.accountsOf(provider.id),
      creditPools: db.dashboard().quotaPools.filter((pool) => pool.providerId === provider.id),
      oauthAvailable: provider.capabilities.oauth,
    });
  }),

  http.patch(route('provider'), async ({ params, request }) => {
    const patch = providerUpdateSchema.parse(await bodyOf(request));
    const updated = db.updateProvider(paramId(params), patch);
    return updated === undefined
      ? notFound('provider', paramId(params))
      : respond(providerSchema, updated);
  }),

  http.delete(route('provider'), ({ params }) => {
    const id = paramId(params);
    return db.removeProvider(id) ? ok() : notFound('provider', id);
  }),

  http.post(route('providerTest'), ({ params }) => {
    const provider = db.provider(paramId(params));
    if (provider === undefined) return notFound('provider', paramId(params));
    const reachable = provider.status !== 'error' && provider.status !== 'disabled';
    const result: ProviderTestResult = {
      ok: reachable,
      latencyMs: reachable ? 180 + ((db.modelsOf(provider.id).length * 37) % 900) : null,
      modelCount: reachable ? db.modelsOf(provider.id).length : null,
      message: reachable
        ? 'Endpoint reachable and listed its models.'
        : 'Endpoint did not respond; check the base URL and credentials.',
      checkedAt: isoAt(0),
    };
    if (reachable && provider.status === 'needs_auth')
      db.updateProvider(provider.id, { status: 'ready' });
    return respond(providerTestResultSchema, result);
  }),

  http.get(route('providerModels'), ({ params }) => {
    const provider = db.provider(paramId(params));
    if (provider === undefined) return notFound('provider', paramId(params));
    return respond(providerModelsResponseSchema, { models: db.modelsOf(provider.id) });
  }),

  http.post(route('providerModels'), async ({ params, request }) => {
    const providerId = paramId(params);
    if (db.provider(providerId) === undefined) return notFound('provider', providerId);
    const input = providerModelInputSchema.parse(await bodyOf(request));
    if (db.model(providerId, input.id) !== undefined) {
      return conflict(`this provider already lists a model with the id "${input.id}"`);
    }
    const model: ProviderModel = {
      id: input.id,
      providerId,
      displayName: input.displayName,
      // Whatever an operator adds through the console is theirs to keep editing.
      source: 'custom',
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      capabilities: input.capabilities,
      inputPricePerMTok: input.inputPricePerMTok,
      outputPricePerMTok: input.outputPricePerMTok,
      deprecated: false,
    };
    db.addProviderModel(providerId, model);
    return respond(providerModelSchema, model);
  }),

  http.patch(route('providerModel'), async ({ params, request }) => {
    const providerId = paramId(params);
    const modelId = paramOf(params, 'modelId');
    const existing = db.model(providerId, modelId);
    if (existing === undefined) return notFound('model', modelId);
    // The provider told us about this one, so it is the provider's claim and not
    // ours to rewrite — the next fetch would undo the edit, and a console that
    // allowed it would be storing a value it could not keep.
    if (existing.source !== 'custom') {
      return badRequest(`model "${modelId}" was not added by hand, so it cannot be edited`);
    }
    const input = providerModelInputSchema.parse(await bodyOf(request));
    if (input.id !== modelId && db.model(providerId, input.id) !== undefined) {
      return conflict(`this provider already lists a model with the id "${input.id}"`);
    }
    const updated = db.replaceProviderModel(providerId, modelId, {
      ...existing,
      ...input,
      providerId,
      source: 'custom',
    });
    return updated === undefined
      ? notFound('model', modelId)
      : respond(providerModelSchema, updated);
  }),

  http.delete(route('providerModel'), ({ params }) => {
    const providerId = paramId(params);
    const modelId = paramOf(params, 'modelId');
    const existing = db.model(providerId, modelId);
    if (existing === undefined) return notFound('model', modelId);
    if (existing.source !== 'custom') {
      return badRequest(`model "${modelId}" was not added by hand, so it cannot be removed`);
    }
    return db.removeProviderModel(providerId, modelId) ? ok() : notFound('model', modelId);
  }),

  http.post(route('providerModelsFetch'), ({ params }) => {
    const provider = db.provider(paramId(params));
    if (provider === undefined) return notFound('provider', paramId(params));
    // A curated provider already has its models. A configured endpoint does not,
    // so the mock answers the fetch the way a real one would: with whatever the
    // endpoint advertises, stored back so the count on the catalog stays honest.
    // Entries an operator added by hand are not "already fetched" — a BYOK
    // endpoint whose only models are custom still has nothing discovered yet.
    const existing = db.modelsOf(provider.id);
    const discovered = existing.filter((model) => model.source !== 'custom');
    const models =
      discovered.length > 0
        ? existing
        : db.setProviderModels(provider.id, synthesizeModels(provider));
    return respond(providerModelsResponseSchema, { models });
  }),

  http.post(route('providerOauth'), ({ params }) => {
    const provider = db.provider(paramId(params));
    if (provider === undefined) return notFound('provider', paramId(params));
    if (!provider.capabilities.oauth) {
      return badRequest(`provider "${provider.id}" does not sign in over OAuth`);
    }
    // The mock cannot finish the exchange — there is no provider on the other end
    // of the authorize URL it hands out — so it reports a started flow and stops
    // there. The callback below is where a real provider would send the browser.
    return respond(providerOauthResultSchema, {
      started: true,
      authorizeUrl: `https://auth.example.test/${provider.id}/authorize?state=${uid('st')}`,
      message: `Opened a sign-in window for ${provider.name}. Finish it there, then return — the console picks up the new credential automatically.`,
    });
  }),

  /**
   * Where the provider sends the browser back (C3b2).
   *
   * Nothing reaches this on its own: the authorize URL above points at a test
   * host, so the redirect lands nowhere real. The handler is here because the
   * real server serves this path, and it answers the way that server will — a
   * redirect to the provider's own page carrying the outcome in the query — so
   * the console's `?oauth=` handling can be exercised by visiting the URL by hand.
   */
  http.get(route('providerOauthCallback'), ({ params, request }) => {
    const id = paramId(params);
    const code = searchParams(request).get('code');
    const outcome = db.provider(id) !== undefined && code !== null ? 'ok' : 'error';
    return new HttpResponse(null, {
      status: 302,
      headers: { location: `/providers/${encodeURIComponent(id)}?oauth=${outcome}` },
    });
  }),

  http.get(route('models'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction, q } = listParams(request);
    const providerId = strParam(params, 'providerId');
    const capability = strParam(params, 'capability');
    const source = strParam(params, 'source');
    const minContext = numParam(params, 'minContext', 0);

    // The catalog's rows are the flat model list joined to its provider, because
    // the table has to name the provider on every line. A model whose provider
    // was deleted mid-session is dropped rather than rendered with a blank name.
    const providerById = new Map(db.providers.map((entry) => [entry.id, entry]));
    let items = db.models.flatMap((model) => {
      const provider = providerById.get(model.providerId);
      if (provider === undefined) return [];
      return [{ ...model, providerName: provider.name, providerIcon: provider.icon }];
    });

    if (providerId !== null) items = items.filter((entry) => entry.providerId === providerId);
    if (source !== null) items = items.filter((entry) => entry.source === source);
    if (minContext > 0) {
      items = items.filter(
        (entry) => entry.contextWindow !== null && entry.contextWindow >= minContext,
      );
    }
    if (capability !== null) {
      items = items.filter(
        (entry) => (entry.capabilities as Record<string, boolean>)[capability] === true,
      );
    }
    // The free-text filter also reads the provider's name: "which of groq's
    // models take tools" starts by typing `groq`, and a search that ignored the
    // provider column would look broken on a page that shows one.
    items = items.filter((entry) =>
      matches([entry.id, entry.displayName, providerById.get(entry.providerId)?.name], q),
    );

    return respond(
      modelCatalogResponseSchema,
      paginate(sortBy(items, sort, direction), { cursor, limit }),
    );
  }),

  http.get(route('accounts'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const providerId = strParam(params, 'providerId');
    const state = strParam(params, 'state');
    const q = params.get('q') ?? '';

    let items = db.accounts;
    if (providerId !== null) items = items.filter((entry) => entry.providerId === providerId);
    if (state !== null) items = items.filter((entry) => entry.state === state);
    items = items.filter((entry) =>
      matches([entry.label, entry.emailMasked, entry.id, entry.note], q),
    );

    return respond(
      accountsResponseSchema,
      paginate(sortBy(items, sort, direction), { cursor, limit }),
    );
  }),

  http.post(route('accounts'), async ({ request }) => {
    const input = accountInputSchema.parse(await bodyOf(request));
    if (db.provider(input.providerId) === undefined)
      return badRequest(`unknown provider "${input.providerId}"`);
    const account: Account = {
      id: uid('acct'),
      providerId: input.providerId,
      label: input.label,
      emailMasked: input.email === null ? null : maskEmail(input.email),
      state: 'pending',
      stateReason: 'Awaiting first use.',
      inFlight: 0,
      maxInFlight: input.maxInFlight,
      cooldownUntil: null,
      quota: {
        windowSeconds: null,
        limit: null,
        remaining: null,
        resetAt: null,
        creditBalance: null,
        creditCurrency: null,
      },
      consecutiveFailures: 0,
      lastUsedAt: null,
      note: input.note,
      createdAt: isoAt(0),
      updatedAt: isoAt(0),
    };
    db.accounts.push(account);
    db.updateProvider(input.providerId, {
      accountCount: db.accountsOf(input.providerId).length,
      activeAccountCount: db
        .accountsOf(input.providerId)
        .filter((entry) => entry.state === 'active').length,
    });
    return respond(accountSchema, account);
  }),

  http.post(route('accountsBulk'), async ({ request }) => {
    const body = bulkAccountActionSchema.parse(await bodyOf(request));
    const errors: { id: string; message: string }[] = [];
    let succeeded = 0;

    for (const id of body.ids) {
      const account = db.account(id);
      if (account === undefined) {
        errors.push({ id, message: 'account not found' });
        continue;
      }
      switch (body.action) {
        case 'enable':
          db.applyAccountState([id], 'active', null);
          break;
        case 'disable':
          db.applyAccountState([id], 'disabled', body.note ?? 'Disabled by an operator.');
          break;
        case 'reset_cooldown':
          db.applyAccountState([id], 'active', 'Cooldown cleared by an operator.');
          break;
        case 'reset_failures':
          db.updateAccount(id, { consecutiveFailures: 0, stateReason: null });
          break;
        case 'rotate':
          db.updateAccount(id, { lastUsedAt: null, stateReason: 'Credential rotated.' });
          break;
        case 'delete':
          db.removeAccount(id);
          break;
      }
      succeeded += 1;
    }

    return respond(bulkResultSchema, {
      requested: body.ids.length,
      succeeded,
      failed: errors.length,
      errors,
    });
  }),

  http.get(route('account'), ({ params }) => {
    const account = db.account(paramId(params));
    return account === undefined
      ? notFound('account', paramId(params))
      : respond(accountSchema, account);
  }),

  http.patch(route('account'), async ({ params, request }) => {
    const patch = accountUpdateSchema.parse(await bodyOf(request));
    delete patch.credential;
    const updated = db.updateAccount(paramId(params), patch);
    return updated === undefined
      ? notFound('account', paramId(params))
      : respond(accountSchema, updated);
  }),

  http.delete(route('account'), ({ params }) => {
    const id = paramId(params);
    return db.removeAccount(id) ? ok() : notFound('account', id);
  }),

  http.get(route('quota'), () => respond(quotaOverviewSchema, db.quotaOverview())),

  http.post(route('quotaCheck'), async ({ request }) => {
    const body = quotaCheckBodySchema.parse(await bodyOf(request));
    const targets =
      body.providerIds.length === 0
        ? db.providers
            .filter((entry) => db.accountsOf(entry.id).length > 0)
            .map((entry) => entry.id)
        : body.providerIds;
    // A real check-in is asynchronous: the sweep starts, the response reports it
    // in flight, and the figures land on a later read. Modelling that here is
    // what lets the console's "checking" state be seen at all.
    db.beginCheckIn(targets);
    return respond(quotaOverviewSchema, db.quotaOverview());
  }),
];
