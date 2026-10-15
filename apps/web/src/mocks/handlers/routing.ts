import { http } from '../net.ts';
import type { Alias, Combo, FilterRule, ModelMappingRule } from '@contracts';
import {
  aliasInputSchema,
  aliasSchema,
  aliasUpdateSchema,
  aliasesResponseSchema,
  apiKeyCreatedSchema,
  apiKeyInputSchema,
  apiKeySchema,
  apiKeyUpdateSchema,
  apiKeysResponseSchema,
  comboInputSchema,
  comboSchema,
  comboUpdateSchema,
  combosResponseSchema,
  deriveApiKeyState,
  filterRuleInputSchema,
  filterRuleSchema,
  filterRuleUpdateSchema,
  filterRulesResponseSchema,
  mappingInputSchema,
  mappingPreviewBodySchema,
  mappingPreviewResultSchema,
  mappingUpdateSchema,
  mappingsResponseSchema,
  modelMappingRuleSchema,
  tokenSaverConfigSchema,
  tokenSaverConfigUpdateSchema,
  tokenSaverSavingsQuerySchema,
  tokenSaverSavingsSchema,
} from '@contracts';

import { db, matches, paginate, sortBy } from '../db.ts';
import { isoAt } from '../clock.ts';
import {
  bodyOf,
  listParams,
  notFound,
  ok,
  paramId,
  respond,
  route,
  searchParams,
  strParam,
  uid,
} from './helpers.ts';

/** Routing section: Combos & Routes, Model Mapping, Filter Rules, Token Saver, API Keys. */

function applyMapping(match: 'exact' | 'contains' | 'regex', pattern: string, replacement: string, input: string): { output: string; matched: boolean } {
  if (match === 'exact') {
    return input === pattern ? { output: replacement, matched: true } : { output: input, matched: false };
  }
  if (match === 'contains') {
    return input.includes(pattern) ? { output: input.replace(pattern, replacement), matched: true } : { output: input, matched: false };
  }
  try {
    const expression = new RegExp(pattern);
    return expression.test(input) ? { output: input.replace(expression, replacement), matched: true } : { output: input, matched: false };
  } catch {
    return { output: input, matched: false };
  }
}

export const routingHandlers = [
  http.get(route('combos'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const q = params.get('q') ?? '';
    const items = db.combos.filter((entry) => matches([entry.name, entry.displayName, entry.description], q));
    return respond(combosResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('combos'), async ({ request }) => {
    const input = comboInputSchema.parse(await bodyOf(request));
    const combo: Combo = {
      id: uid('combo'),
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      strategy: input.strategy,
      entries: input.entries.map((entry) => ({
        id: uid('entry'),
        model: entry.model,
        providerId: entry.providerId,
        weight: entry.weight,
        enabled: entry.enabled,
      })),
      fallbackOnError: input.fallbackOnError,
      enabled: input.enabled,
      createdAt: isoAt(0),
      updatedAt: isoAt(0),
    };
    db.combos.push(combo);
    return respond(comboSchema, combo);
  }),

  http.get(route('combo'), ({ params }) => {
    const combo = db.combo(paramId(params));
    return combo === undefined ? notFound('combo', paramId(params)) : respond(comboSchema, combo);
  }),

  http.patch(route('combo'), async ({ params, request }) => {
    const combo = db.combo(paramId(params));
    if (combo === undefined) return notFound('combo', paramId(params));
    const patch = comboUpdateSchema.parse(await bodyOf(request));
    if (patch.displayName !== undefined) combo.displayName = patch.displayName;
    if (patch.description !== undefined) combo.description = patch.description;
    if (patch.strategy !== undefined) combo.strategy = patch.strategy;
    if (patch.fallbackOnError !== undefined) combo.fallbackOnError = patch.fallbackOnError;
    if (patch.enabled !== undefined) combo.enabled = patch.enabled;
    if (patch.entries !== undefined) {
      combo.entries = patch.entries.map((entry) => ({
        id: uid('entry'),
        model: entry.model,
        providerId: entry.providerId,
        weight: entry.weight,
        enabled: entry.enabled,
      }));
    }
    combo.updatedAt = isoAt(0);
    return respond(comboSchema, combo);
  }),

  http.delete(route('combo'), ({ params }) => {
    const index = db.combos.findIndex((entry) => entry.id === paramId(params));
    if (index === -1) return notFound('combo', paramId(params));
    db.combos.splice(index, 1);
    return ok();
  }),

  http.get(route('aliases'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const q = params.get('q') ?? '';
    const items = db.aliases.filter((entry) => matches([entry.alias, entry.target, entry.description], q));
    return respond(aliasesResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('aliases'), async ({ request }) => {
    const input = aliasInputSchema.parse(await bodyOf(request));
    const alias: Alias = {
      id: uid('alias'),
      alias: input.alias,
      target: input.target,
      providerId: input.providerId,
      enabled: input.enabled,
      description: input.description,
      createdAt: isoAt(0),
      updatedAt: isoAt(0),
    };
    db.aliases.push(alias);
    return respond(aliasSchema, alias);
  }),

  http.get(route('alias'), ({ params }) => {
    const alias = db.alias(paramId(params));
    return alias === undefined ? notFound('alias', paramId(params)) : respond(aliasSchema, alias);
  }),

  http.patch(route('alias'), async ({ params, request }) => {
    const alias = db.alias(paramId(params));
    if (alias === undefined) return notFound('alias', paramId(params));
    const patch = aliasUpdateSchema.parse(await bodyOf(request));
    if (patch.target !== undefined) alias.target = patch.target;
    if (patch.providerId !== undefined) alias.providerId = patch.providerId;
    if (patch.description !== undefined) alias.description = patch.description;
    if (patch.enabled !== undefined) alias.enabled = patch.enabled;
    alias.updatedAt = isoAt(0);
    return respond(aliasSchema, alias);
  }),

  http.delete(route('alias'), ({ params }) => {
    const index = db.aliases.findIndex((entry) => entry.id === paramId(params));
    if (index === -1) return notFound('alias', paramId(params));
    db.aliases.splice(index, 1);
    return ok();
  }),

  http.get(route('mappings'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const q = params.get('q') ?? '';
    const items = db.mappings.filter((entry) => matches([entry.pattern, entry.replacement, entry.description], q));
    return respond(mappingsResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('mappings'), async ({ request }) => {
    const input = mappingInputSchema.parse(await bodyOf(request));
    const mapping: ModelMappingRule = {
      id: uid('map'),
      match: input.match,
      pattern: input.pattern,
      replacement: input.replacement,
      priority: input.priority,
      enabled: input.enabled,
      description: input.description,
      createdAt: isoAt(0),
      updatedAt: isoAt(0),
    };
    db.mappings.push(mapping);
    return respond(modelMappingRuleSchema, mapping);
  }),

  http.post(route('mappingsPreview'), async ({ request }) => {
    const body = mappingPreviewBodySchema.parse(await bodyOf(request));
    return respond(mappingPreviewResultSchema, {
      results: body.samples.map((sample) => ({
        input: sample,
        ...applyMapping(body.match, body.pattern, body.replacement, sample),
      })),
    });
  }),

  http.get(route('mapping'), ({ params }) => {
    const mapping = db.mapping(paramId(params));
    return mapping === undefined ? notFound('mapping', paramId(params)) : respond(modelMappingRuleSchema, mapping);
  }),

  http.patch(route('mapping'), async ({ params, request }) => {
    const mapping = db.mapping(paramId(params));
    if (mapping === undefined) return notFound('mapping', paramId(params));
    const patch = mappingUpdateSchema.parse(await bodyOf(request));
    if (patch.match !== undefined) mapping.match = patch.match;
    if (patch.pattern !== undefined) mapping.pattern = patch.pattern;
    if (patch.replacement !== undefined) mapping.replacement = patch.replacement;
    if (patch.priority !== undefined) mapping.priority = patch.priority;
    if (patch.description !== undefined) mapping.description = patch.description;
    if (patch.enabled !== undefined) mapping.enabled = patch.enabled;
    mapping.updatedAt = isoAt(0);
    return respond(modelMappingRuleSchema, mapping);
  }),

  http.delete(route('mapping'), ({ params }) => {
    const index = db.mappings.findIndex((entry) => entry.id === paramId(params));
    if (index === -1) return notFound('mapping', paramId(params));
    db.mappings.splice(index, 1);
    return ok();
  }),

  // The compression pipeline. The savings route is registered before the config
  // one, because MSW resolves to the first match and `/token-saver` would
  // otherwise be reached for `/token-saver/savings`.
  http.get(route('tokenSaverSavings'), ({ request }) => {
    const parsed = tokenSaverSavingsQuerySchema.safeParse({
      window: strParam(searchParams(request), 'window') ?? undefined,
    });
    return respond(
      tokenSaverSavingsSchema,
      db.tokenSaverSavings(parsed.success ? parsed.data.window : '7d'),
    );
  }),

  http.get(route('tokenSaver'), () => respond(tokenSaverConfigSchema, db.tokenSaver)),

  http.patch(route('tokenSaver'), async ({ request }) => {
    const patch = tokenSaverConfigUpdateSchema.parse(await bodyOf(request));
    return respond(tokenSaverConfigSchema, db.updateTokenSaver(patch));
  }),

  http.get(route('apiKeys'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const state = strParam(params, 'state');
    const q = params.get('q') ?? '';

    let items = db.apiKeys;
    if (state !== null) items = items.filter((entry) => deriveApiKeyState(entry) === state);
    items = items.filter((entry) => matches([entry.name, entry.prefix, entry.id], q));

    return respond(apiKeysResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('apiKeys'), async ({ request }) => {
    const input = apiKeyInputSchema.parse(await bodyOf(request));
    const created = db.createApiKey(input);
    return respond(apiKeyCreatedSchema, created);
  }),

  http.get(route('apiKey'), ({ params }) => {
    const apiKey = db.apiKey(paramId(params));
    return apiKey === undefined ? notFound('api key', paramId(params)) : respond(apiKeySchema, apiKey);
  }),

  http.patch(route('apiKey'), async ({ params, request }) => {
    const patch = apiKeyUpdateSchema.parse(await bodyOf(request));
    const updated = db.updateApiKey(paramId(params), patch);
    return updated === undefined ? notFound('api key', paramId(params)) : respond(apiKeySchema, updated);
  }),

  http.delete(route('apiKey'), ({ params }) => {
    const id = paramId(params);
    return db.removeApiKey(id) ? ok() : notFound('api key', id);
  }),

  http.post(route('apiKeyRevoke'), ({ params }) => {
    const revoked = db.revokeApiKey(paramId(params));
    return revoked === undefined ? notFound('api key', paramId(params)) : respond(apiKeySchema, revoked);
  }),

  // Content filters. The list route is registered before the parameterised one,
  // because MSW resolves to the first match and `/filter-rules/:id` would
  // otherwise swallow it.
  http.get(route('filterRules'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const q = params.get('q') ?? '';
    const items = db.filterRules.filter((entry) => matches([entry.name, entry.pattern], q));
    return respond(filterRulesResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('filterRules'), async ({ request }) => {
    const input = filterRuleInputSchema.parse(await bodyOf(request));
    const rule: FilterRule = {
      id: uid('filter'),
      name: input.name,
      kind: input.kind,
      pattern: input.pattern,
      action: input.action,
      phase: input.phase,
      enabled: input.enabled,
      createdAt: isoAt(0),
      updatedAt: isoAt(0),
    };
    db.filterRules.push(rule);
    return respond(filterRuleSchema, rule);
  }),

  http.get(route('filterRule'), ({ params }) => {
    const rule = db.filterRule(paramId(params));
    return rule === undefined ? notFound('filter rule', paramId(params)) : respond(filterRuleSchema, rule);
  }),

  http.patch(route('filterRule'), async ({ params, request }) => {
    const rule = db.filterRule(paramId(params));
    if (rule === undefined) return notFound('filter rule', paramId(params));
    const patch = filterRuleUpdateSchema.parse(await bodyOf(request));
    if (patch.name !== undefined) rule.name = patch.name;
    if (patch.kind !== undefined) rule.kind = patch.kind;
    if (patch.pattern !== undefined) rule.pattern = patch.pattern;
    if (patch.action !== undefined) rule.action = patch.action;
    if (patch.phase !== undefined) rule.phase = patch.phase;
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    rule.updatedAt = isoAt(0);
    return respond(filterRuleSchema, rule);
  }),

  http.delete(route('filterRule'), ({ params }) => {
    const index = db.filterRules.findIndex((entry) => entry.id === paramId(params));
    if (index === -1) return notFound('filter rule', paramId(params));
    db.filterRules.splice(index, 1);
    return ok();
  }),
];
