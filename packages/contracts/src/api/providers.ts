import { z } from 'zod';
import { isoDateTimeSchema, pageSchema, slugSchema } from '../common.ts';
import { accountSchema, accountStateSchema } from '../entities/account.ts';
import {
  modelSourceSchema,
  providerCategorySchema,
  providerModelSchema,
  providerSchema,
  providerStatusSchema,
  wireFamilySchema,
} from '../entities/provider.ts';
import { creditPoolSchema } from '../entities/system.ts';
import { searchQuerySchema, updateSchema } from './shared.ts';

/** Providers section: Provider Catalog, Provider Detail, Accounts, Quota. */

/* ---- Provider Catalog (B2) ---- */

export const providersQuerySchema = searchQuerySchema.extend({
  category: providerCategorySchema.nullable().default(null),
  status: providerStatusSchema.nullable().default(null),
  /** A tri-state, because a query-string boolean cannot round-trip "false". */
  tier: z.enum(['all', 'free', 'paid']).default('all'),
});
export type ProvidersQuery = z.infer<typeof providersQuerySchema>;

/**
 * Creating a BYOK provider (FR-2.5). The credential is write-only: it is
 * accepted here and never appears on any read model.
 */
export const providerInputSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(280).default(''),
  category: providerCategorySchema,
  wireFamily: wireFamilySchema,
  /** Null for a provider whose endpoint is fixed and hard-coded. */
  baseUrl: z.string().nullable().default(null),
  docsUrl: z.string().nullable().default(null),
  /** Icon slug resolved by the frontend icon map; never a URL. */
  icon: z.string().min(1).default('box'),
  apiKey: z.string().nullable().default(null),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;

export const providerUpdateSchema = updateSchema(providerInputSchema.shape);
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

/** Result of the catalog's "test connection" affordance. */
export const providerTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  /** How many models the endpoint listed, when the probe asked for them. */
  modelCount: z.number().int().nonnegative().nullable(),
  message: z.string(),
  checkedAt: isoDateTimeSchema,
});
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>;

export const providerModelsResponseSchema = z.object({
  models: z.array(providerModelSchema),
});
export type ProviderModelsResponse = z.infer<typeof providerModelsResponseSchema>;

/**
 * A model an operator adds to a provider by hand, and the same body used to edit
 * one (FR-2.6).
 *
 * Create and edit share a shape on purpose: the dialog is a form with every field
 * on it, so a submit is a complete statement about the model rather than a diff
 * against a row the server would have to be trusted to still have. `id` is the
 * string the provider itself expects on the wire — rutekit cannot guess what an
 * endpoint calls its models — and on an edit it doubles as the rename, which is
 * why the route's `:modelId` names the row while this names what it becomes.
 *
 * Nothing here reaches a `template` or `synced` entry: those belong to the
 * provider, and the boundary refuses to move them.
 */
export const providerModelInputSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  contextWindow: z.number().int().positive().nullable().default(null),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  capabilities: z
    .object({
      vision: z.boolean().default(false),
      tools: z.boolean().default(false),
      reasoning: z.boolean().default(false),
      embedding: z.boolean().default(false),
    })
    .default({ vision: false, tools: false, reasoning: false, embedding: false }),
  /** USD per million tokens; null when the operator does not price it. */
  inputPricePerMTok: z.number().nonnegative().nullable().default(null),
  outputPricePerMTok: z.number().nonnegative().nullable().default(null),
});
export type ProviderModelInput = z.infer<typeof providerModelInputSchema>;

/**
 * Result of starting an OAuth sign-in (FR-2.4). The browser cannot finish the
 * flow — the provider redirects to a server-side callback — so the console
 * reports only that a flow was started, and, for providers that need the
 * operator to open a page, the URL to open.
 */
export const providerOauthResultSchema = z.object({
  started: z.boolean(),
  authorizeUrl: z.string().nullable(),
  message: z.string(),
});
export type ProviderOauthResult = z.infer<typeof providerOauthResultSchema>;

export const providerDetailSchema = z.object({
  provider: providerSchema,
  models: z.array(providerModelSchema),
  accounts: z.array(accountSchema),
  creditPools: z.array(creditPoolSchema),
  /** Whether this provider can be re-authenticated from the browser. */
  oauthAvailable: z.boolean(),
});
export type ProviderDetail = z.infer<typeof providerDetailSchema>;

/* ---- Model Catalog (B2.5) ---- */

/** The four capability flags a model can carry, as a filterable name. */
export const modelCapabilitySchema = z.enum(['vision', 'tools', 'reasoning', 'embedding']);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  'vision',
  'tools',
  'reasoning',
  'embedding',
];

/**
 * A model as the catalog lists it: the same row Provider Detail shows, plus the
 * provider's own name and icon.
 *
 * Denormalised on purpose. The catalog exists to answer "which provider serves
 * this id", and a row carrying only a `providerId` would make every consumer
 * hold the provider list to render one line — which is the lookup table the
 * endpoint was supposed to save them. The join is done once, on the server,
 * where both halves are already in hand.
 */
export const modelCatalogEntrySchema = providerModelSchema.extend({
  providerName: z.string(),
  providerIcon: z.string(),
});
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;

/**
 * The catalog's filters. Every one is nullable and defaults to "off" so an
 * empty query is the whole list — which is what a deep link with no parameters
 * has to mean.
 *
 * `minContext` is a floor rather than a range: an operator filtering context is
 * asking "what can hold my document", not "what sits between these two sizes",
 * and a single number is one URL parameter instead of two.
 */
export const modelsQuerySchema = searchQuerySchema.extend({
  providerId: z.string().nullable().default(null),
  capability: modelCapabilitySchema.nullable().default(null),
  source: modelSourceSchema.nullable().default(null),
  /** Smallest context window to include, in tokens. Null means no floor. */
  minContext: z.coerce.number().int().positive().nullable().default(null),
});
export type ModelsQuery = z.infer<typeof modelsQuerySchema>;

/**
 * Named for the catalog rather than plain `modelsResponse`, which the data plane
 * already owns: `/v1/models` is the OpenAI-shaped list a client discovers
 * against, and this is the console's own page of rows. Same word, different
 * plane, so they must not collide in the barrel.
 */
export const modelCatalogResponseSchema = pageSchema(modelCatalogEntrySchema);
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;

/* ---- Accounts (B2) ---- */

export const accountsQuerySchema = searchQuerySchema.extend({
  providerId: z.string().nullable().default(null),
  state: accountStateSchema.nullable().default(null),
});
export type AccountsQuery = z.infer<typeof accountsQuerySchema>;

/** Adding an account by hand, outside the browser automation path. */
export const accountInputSchema = z.object({
  providerId: slugSchema,
  label: z.string().min(1).max(64),
  /** Write-only credential blob: an API key, refresh token, or cookie jar. */
  credential: z.string().min(1),
  email: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
  maxInFlight: z.number().int().positive().default(1),
});
export type AccountInput = z.infer<typeof accountInputSchema>;

export const accountUpdateSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  note: z.string().nullable().optional(),
  maxInFlight: z.number().int().positive().optional(),
  /** Move the account by hand: pause it, re-enable it, quarantine it. */
  state: accountStateSchema.optional(),
  stateReason: z.string().nullable().optional(),
  credential: z.string().nullable().optional(),
});
export type AccountUpdate = z.infer<typeof accountUpdateSchema>;

/** The bulk bar above the Accounts table. */
export const bulkAccountActionSchema = z.object({
  ids: z.array(z.string()).min(1),
  action: z.enum(['enable', 'disable', 'reset_cooldown', 'reset_failures', 'rotate', 'delete']),
  note: z.string().nullable().default(null),
});
export type BulkAccountAction = z.infer<typeof bulkAccountActionSchema>;

/* ---- Quota Management (B2) ---- */

/** One quota window rolled up across a provider's accounts. */
export const quotaWindowSchema = z.object({
  windowSeconds: z.number().int().positive(),
  limit: z.number().nonnegative(),
  remaining: z.number().nonnegative(),
  resetAt: isoDateTimeSchema.nullable(),
});
export type QuotaWindow = z.infer<typeof quotaWindowSchema>;

export const quotaRowSchema = z.object({
  providerId: slugSchema,
  providerName: z.string(),
  windows: z.array(quotaWindowSchema),
  creditPools: z.array(creditPoolSchema),
  lastCheckedAt: isoDateTimeSchema.nullable(),
  /** True while a check-in is in flight for this provider. */
  checking: z.boolean(),
});
export type QuotaRow = z.infer<typeof quotaRowSchema>;

export const quotaOverviewSchema = z.object({
  rows: z.array(quotaRowSchema),
  /** Seconds until the next scheduled sweep of every provider; null when off. */
  nextSweepInSeconds: z.number().int().nonnegative().nullable(),
});
export type QuotaOverview = z.infer<typeof quotaOverviewSchema>;

/** Trigger a check-in. An empty list means "every provider". */
export const quotaCheckBodySchema = z.object({
  providerIds: z.array(z.string()).default([]),
});
export type QuotaCheckBody = z.infer<typeof quotaCheckBodySchema>;

export const accountsResponseSchema = pageSchema(accountSchema);
export type AccountsResponse = z.infer<typeof accountsResponseSchema>;

export const providersResponseSchema = pageSchema(providerSchema);
export type ProvidersResponse = z.infer<typeof providersResponseSchema>;
