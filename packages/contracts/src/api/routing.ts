import { z } from 'zod';
import { isoDateTimeSchema, pageSchema, slugSchema, timeWindowSchema } from '../common.ts';
import { apiKeySchema, apiKeyStateSchema } from '../entities/api-key.ts';
import {
  aliasSchema,
  comboSchema,
  loadBalanceStrategySchema,
  mappingMatchSchema,
  modelMappingRuleSchema,
} from '../entities/routing.ts';
import { tokenSaverConfigSchema } from '../entities/token-saver.ts';
import { searchQuerySchema, updateSchema } from './shared.ts';

/** Routing section: Combos & Routes, Model Mapping, API Keys, Token Saver. */

/* ---- Combos & Routes (B3) ---- */

export const comboEntryInputSchema = z.object({
  model: z.string().min(1),
  providerId: slugSchema.nullable().default(null),
  weight: z.number().positive().default(1),
  enabled: z.boolean().default(true),
});
export type ComboEntryInput = z.infer<typeof comboEntryInputSchema>;

export const comboInputSchema = z.object({
  name: slugSchema,
  displayName: z.string().min(1).max(64),
  description: z.string().nullable().default(null),
  strategy: loadBalanceStrategySchema.default('sequential'),
  entries: z.array(comboEntryInputSchema).min(1),
  fallbackOnError: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type ComboInput = z.infer<typeof comboInputSchema>;

export const comboUpdateSchema = updateSchema(comboInputSchema.shape);
export type ComboUpdate = z.infer<typeof comboUpdateSchema>;

export const aliasInputSchema = z.object({
  alias: slugSchema,
  target: z.string().min(1),
  providerId: slugSchema.nullable().default(null),
  description: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
export type AliasInput = z.infer<typeof aliasInputSchema>;

export const aliasUpdateSchema = updateSchema(aliasInputSchema.shape);
export type AliasUpdate = z.infer<typeof aliasUpdateSchema>;

export const combosResponseSchema = pageSchema(comboSchema);
export type CombosResponse = z.infer<typeof combosResponseSchema>;

export const aliasesResponseSchema = pageSchema(aliasSchema);
export type AliasesResponse = z.infer<typeof aliasesResponseSchema>;

/* ---- Model Mapping (B3) ---- */

export const mappingInputSchema = z.object({
  match: mappingMatchSchema,
  pattern: z.string().min(1),
  replacement: z.string(),
  /** Lower numbers run first. */
  priority: z.number().int().default(0),
  description: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
export type MappingInput = z.infer<typeof mappingInputSchema>;

export const mappingUpdateSchema = updateSchema(mappingInputSchema.shape);
export type MappingUpdate = z.infer<typeof mappingUpdateSchema>;

/** Run a draft rule against sample model ids without saving it. */
export const mappingPreviewBodySchema = z.object({
  match: mappingMatchSchema,
  pattern: z.string(),
  replacement: z.string(),
  samples: z.array(z.string()).min(1),
});
export type MappingPreviewBody = z.infer<typeof mappingPreviewBodySchema>;

export const mappingPreviewResultSchema = z.object({
  results: z.array(
    z.object({ input: z.string(), output: z.string(), matched: z.boolean() }),
  ),
});
export type MappingPreviewResult = z.infer<typeof mappingPreviewResultSchema>;

export const mappingsResponseSchema = pageSchema(modelMappingRuleSchema);
export type MappingsResponse = z.infer<typeof mappingsResponseSchema>;

/* ---- API Keys (B3) ---- */

export const apiKeysQuerySchema = searchQuerySchema.extend({
  state: apiKeyStateSchema.nullable().default(null),
});
export type ApiKeysQuery = z.infer<typeof apiKeysQuerySchema>;

/** The creation form: scope chips, expiry picker, TPS ceiling, budgets, denylist. */
export const apiKeyInputSchema = z.object({
  name: z.string().min(1).max(64),
  /** Empty means "all models"; a non-empty list is an allowlist. */
  modelsAllowed: z.array(z.string()).default([]),
  modelsDenied: z.array(z.string()).default([]),
  budgetRequests: z.number().int().positive().nullable().default(null),
  budgetTokens: z.number().int().positive().nullable().default(null),
  tpsLimit: z.number().int().positive().nullable().default(null),
  rateLimitPerMinute: z.number().int().positive().nullable().default(null),
  expiresAt: isoDateTimeSchema.nullable().default(null),
  clientRouterDenylist: z.array(z.string()).default([]),
});
export type ApiKeyInput = z.infer<typeof apiKeyInputSchema>;

export const apiKeyUpdateSchema = updateSchema(apiKeyInputSchema.shape);
export type ApiKeyUpdate = z.infer<typeof apiKeyUpdateSchema>;

export const apiKeysResponseSchema = pageSchema(apiKeySchema);
export type ApiKeysResponse = z.infer<typeof apiKeysResponseSchema>;

/* ---- Token Saver (B3) ---- */

/**
 * The settings form is the whole record minus the server's own timestamp, so
 * the update schema is derived from the read schema rather than declared again
 * (R1.6). Every field is optional: the page sends the one control that moved.
 */
export const tokenSaverConfigUpdateSchema = updateSchema(
  tokenSaverConfigSchema.omit({ updatedAt: true }).shape,
);
export type TokenSaverConfigUpdate = z.infer<typeof tokenSaverConfigUpdateSchema>;

export const tokenSaverSavingsQuerySchema = z.object({
  window: timeWindowSchema.default('7d'),
});
export type TokenSaverSavingsQuery = z.infer<typeof tokenSaverSavingsQuerySchema>;
