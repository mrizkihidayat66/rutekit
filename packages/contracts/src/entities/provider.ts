import { z } from 'zod';
import { isoDateTimeSchema, slugSchema } from '../common.ts';

/**
 * Categories mirror how a provider is authenticated and what it serves.
 * `byok` is deliberately its own category: user-supplied OpenAI/Anthropic-compatible
 * endpoints are configured, not discovered (FR-2.5). `free` is likewise its own
 * because "no credential" is not a flavour of `api-key`: a public endpoint has
 * nothing to paste, nothing to sign in with, and no pool to hold.
 */
export const providerCategorySchema = z.enum([
  'oauth',
  'api-key',
  'media',
  'search',
  'local',
  'byok',
  'aggregator',
  'free',
]);

/**
 * Which request/response dialect the provider speaks on the wire.
 *
 * `custom` is not "a dialect rutekit has not learned" — it is the absence of one,
 * and it has no codec on purpose: a provider whose wire nobody knows cannot be
 * reached through `/v1` at all, only probed. Adding a family here is what makes a
 * provider reachable, and each one is a codec in `packages/translator`.
 *
 * `kiro` is the fourth that has one. Its request is JSON of its own shape and its
 * response is AWS EventStream — length-prefixed binary, not SSE — so it is a
 * family rather than a variation on any of the three above.
 */
export const wireFamilySchema = z.enum(['openai', 'anthropic', 'google', 'kiro', 'custom']);

export const providerStatusSchema = z.enum(['ready', 'needs_auth', 'error', 'disabled']);

/**
 * What a provider can do, as the catalog and detail views report it.
 *
 * Declared once and shared with the server-side provider registry, so a manifest
 * cannot describe a provider whose capability block has drifted from the one the
 * API serves. The registry still checks the flags against the rest of a manifest
 * — `oauth` has to agree with the auth mode — because agreeing on the shape is
 * not the same as agreeing on the values.
 */
export const providerCapabilitiesSchema = z.object({
  quota: z.boolean(),
  oauth: z.boolean(),
  automation: z.boolean(),
  streaming: z.boolean(),
  vision: z.boolean(),
  tools: z.boolean(),
});

export const providerSchema = z.object({
  id: slugSchema,
  name: z.string(),
  description: z.string(),
  category: providerCategorySchema,
  status: providerStatusSchema,
  /** Icon slug resolved by the frontend icon map; never a URL. */
  icon: z.string(),
  /** Null for providers with a fixed, hard-coded endpoint. */
  baseUrl: z.string().nullable(),
  wireFamily: wireFamilySchema,
  docsUrl: z.string().nullable(),
  freeTier: z.boolean(),

  capabilities: providerCapabilitiesSchema,

  modelCount: z.number().int().nonnegative(),
  accountCount: z.number().int().nonnegative(),
  activeAccountCount: z.number().int().nonnegative(),

  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * Where a model entry came from, which is also whether rutekit may change it.
 *
 * `template` is the curated catalog's own list and `synced` is what an endpoint
 * answered when its models were last fetched. Both are the provider's claim about
 * itself, so neither is editable — an edit would be overwritten the next time the
 * endpoint is asked, and a console that let it happen would be lying about what
 * it stored. `custom` is an entry an operator added by hand: rutekit owns it, so
 * it is the only source that can be edited or removed.
 */
export const modelSourceSchema = z.enum(['template', 'synced', 'custom']);

/** A model as advertised by a provider, before alias/mapping is applied. */
export const providerModelSchema = z.object({
  id: z.string(),
  providerId: slugSchema,
  displayName: z.string(),
  source: modelSourceSchema,
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  capabilities: z.object({
    vision: z.boolean(),
    tools: z.boolean(),
    reasoning: z.boolean(),
    embedding: z.boolean(),
  }),
  /** USD per million tokens; null when the provider does not price per token. */
  inputPricePerMTok: z.number().nonnegative().nullable(),
  outputPricePerMTok: z.number().nonnegative().nullable(),
  deprecated: z.boolean(),
});

export type ProviderCategory = z.infer<typeof providerCategorySchema>;
export type WireFamily = z.infer<typeof wireFamilySchema>;
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export type ModelSource = z.infer<typeof modelSourceSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type ProviderModel = z.infer<typeof providerModelSchema>;
