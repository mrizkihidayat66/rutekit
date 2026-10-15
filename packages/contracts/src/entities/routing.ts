import { z } from 'zod';
import { isoDateTimeSchema, slugSchema } from '../common.ts';

/** A friendly name that resolves to a real model id (FR-1.3). */
export const aliasSchema = z.object({
  id: z.string(),
  /** The name clients send, e.g. `fast`. */
  alias: slugSchema,
  /** The model id it resolves to, e.g. `gpt-4o-mini`. */
  target: z.string(),
  providerId: slugSchema.nullable(),
  enabled: z.boolean(),
  description: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const loadBalanceStrategySchema = z.enum(['round_robin', 'sequential']);

/** One step in a combo: a model to try, optionally pinned to a provider. */
export const comboEntrySchema = z.object({
  id: z.string(),
  model: z.string(),
  providerId: slugSchema.nullable(),
  /** Relative weight for weighted selection; 1 when unweighted. */
  weight: z.number().positive().default(1),
  enabled: z.boolean(),
});

/** An ordered fallback chain presented to clients as a single model (FR-1.4). */
export const comboSchema = z.object({
  id: z.string(),
  name: slugSchema,
  displayName: z.string(),
  description: z.string().nullable(),
  strategy: loadBalanceStrategySchema,
  entries: z.array(comboEntrySchema),
  /** Try the next entry when the current one fails; off means fail fast. */
  fallbackOnError: z.boolean(),
  enabled: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const mappingMatchSchema = z.enum(['exact', 'contains', 'regex']);

/** A rewrite rule applied at the edge before routing (FR-1.5). */
export const modelMappingRuleSchema = z.object({
  id: z.string(),
  match: mappingMatchSchema,
  pattern: z.string(),
  replacement: z.string(),
  /** Lower numbers run first. */
  priority: z.number().int(),
  enabled: z.boolean(),
  description: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Client-supplied content filter: regex or exact substring, evaluated in two phases (FR-11.3). */
export const filterRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['regex', 'exact']),
  pattern: z.string(),
  /** `block` rejects the request; `redact` replaces the match. */
  action: z.enum(['block', 'redact']),
  /** Phase 1 runs before compression, phase 2 after. */
  phase: z.union([z.literal(1), z.literal(2)]),
  enabled: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Alias = z.infer<typeof aliasSchema>;
export type LoadBalanceStrategy = z.infer<typeof loadBalanceStrategySchema>;
export type ComboEntry = z.infer<typeof comboEntrySchema>;
export type Combo = z.infer<typeof comboSchema>;
export type MappingMatch = z.infer<typeof mappingMatchSchema>;
export type ModelMappingRule = z.infer<typeof modelMappingRuleSchema>;
export type FilterRule = z.infer<typeof filterRuleSchema>;
