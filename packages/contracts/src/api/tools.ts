import { z } from 'zod';
import { contentBlockSchema } from '../canonical.ts';
import { isoDateTimeSchema, pageSchema } from '../common.ts';
import {
  assetKindSchema,
  assetSchema,
  generationJobSchema,
  generationJobStatusSchema,
} from '../entities/asset.ts';
import {
  benchmarkAssertionSchema,
  benchmarkSummarySchema,
  benchmarkTargetSchema,
} from '../entities/benchmark.ts';
import {
  chatAttachmentSchema,
  chatSessionSummarySchema,
  thinkingLevelSchema,
} from '../entities/chat.ts';
import { filterRuleSchema } from '../entities/routing.ts';
import { probeBudgetSchema, verificationResultSchema } from '../entities/verification.ts';
import {
  vccBinSchema,
  vccBrandSchema,
  vccCardSchema,
  vccCardStatusSchema,
} from '../entities/vcc.ts';
import { listQuerySchema, searchQuerySchema, updateSchema } from './shared.ts';

/** Tools section: Chat, Studio, Benchmark, Model Verification, Tools. */

/* ---- Chat (B5) ---- */

export const chatSessionsQuerySchema = searchQuerySchema;
export type ChatSessionsQuery = z.infer<typeof chatSessionsQuerySchema>;

export const chatSessionsResponseSchema = pageSchema(chatSessionSummarySchema);
export type ChatSessionsResponse = z.infer<typeof chatSessionsResponseSchema>;

export const chatSessionInputSchema = z.object({
  title: z.string().min(1).max(120).default('New chat'),
  providerId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  thinkingLevel: thinkingLevelSchema.default('auto'),
  systemPrompt: z.string().nullable().default(null),
});
export type ChatSessionInput = z.infer<typeof chatSessionInputSchema>;

export const chatSessionUpdateSchema = updateSchema(chatSessionInputSchema.shape);
export type ChatSessionUpdate = z.infer<typeof chatSessionUpdateSchema>;

/** Append a turn. The reply arrives over the `chat` WebSocket channel. */
export const chatMessageInputSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.array(contentBlockSchema).min(1),
  attachments: z.array(chatAttachmentSchema).default([]),
  parentMessageId: z.string().nullable().default(null),
});
export type ChatMessageInput = z.infer<typeof chatMessageInputSchema>;

/**
 * A turn that expects a streamed answer.
 *
 * The body of `POST /chat/sessions/:id/messages` when the caller wants the reply
 * back on the same connection. The response is `text/event-stream` carrying AI
 * SDK UI Message chunks — the same frames PHASE C's Hono handler will emit, so
 * the page is written against the real wire protocol rather than a stand-in.
 *
 * It carries the routing trio as well as the message: the reply depends on which
 * provider and model were selected and whether the session asked the model to
 * think, and none of those live on the message itself.
 */
export const chatTurnRequestSchema = chatMessageInputSchema.extend({
  providerId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  thinkingLevel: thinkingLevelSchema.default('auto'),
});
export type ChatTurnRequest = z.infer<typeof chatTurnRequestSchema>;

/* ---- Studio (B5) ---- */

export const studioAssetsQuerySchema = searchQuerySchema.extend({
  kind: assetKindSchema.nullable().default(null),
  favorite: z.boolean().default(false),
});
export type StudioAssetsQuery = z.infer<typeof studioAssetsQuerySchema>;

export const studioAssetsResponseSchema = pageSchema(assetSchema);
export type StudioAssetsResponse = z.infer<typeof studioAssetsResponseSchema>;

export const studioGenerationsQuerySchema = listQuerySchema.extend({
  kind: assetKindSchema.nullable().default(null),
  status: generationJobStatusSchema.nullable().default(null),
});
export type StudioGenerationsQuery = z.infer<typeof studioGenerationsQuerySchema>;

export const studioGenerationsResponseSchema = pageSchema(generationJobSchema);
export type StudioGenerationsResponse = z.infer<typeof studioGenerationsResponseSchema>;

export const studioGenerateBodySchema = z.object({
  kind: assetKindSchema,
  providerId: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().min(1),
  negativePrompt: z.string().nullable().default(null),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Batch size; the backend fans out into that many generation jobs. */
  count: z.number().int().positive().max(8).default(1),
  /**
   * The asset this render was seeded from (FR-8.4's refine/variation/upscale).
   *
   * The composer already loads a previous asset's prompt and settings, and until
   * now the new render had no way to say where they came from — the console could
   * only *claim* the lineage in a caption. `Asset.parentAssetId` has been in the
   * contract since PHASE B with nothing to fill it, so this is the missing half
   * rather than a new field.
   */
  parentAssetId: z.string().nullable().default(null),
});
export type StudioGenerateBody = z.infer<typeof studioGenerateBodySchema>;

export const studioGenerateResultSchema = z.object({ jobs: z.array(generationJobSchema) });
export type StudioGenerateResult = z.infer<typeof studioGenerateResultSchema>;

export const studioAssetUpdateSchema = z.object({ favorite: z.boolean() });
export type StudioAssetUpdate = z.infer<typeof studioAssetUpdateSchema>;

/* ---- Benchmark (B5) ---- */

/** The list carries runs without their cells; the detail carries the cells. */
export const benchmarksResponseSchema = pageSchema(benchmarkSummarySchema);
export type BenchmarksResponse = z.infer<typeof benchmarksResponseSchema>;

export const benchmarkVariantInputSchema = z.object({
  label: z.string().min(1),
  prompt: z.string().min(1),
  variables: z.record(z.string(), z.string()).default({}),
});
export type BenchmarkVariantInput = z.infer<typeof benchmarkVariantInputSchema>;

export const benchmarkInputSchema = z.object({
  name: z.string().min(1).max(120),
  /** The template the variants were expanded from, kept for re-runs. */
  template: z.string().min(1),
  variants: z.array(benchmarkVariantInputSchema).min(1),
  targets: z.array(benchmarkTargetSchema).min(1),
  systemPrompt: z.string().nullable().default(null),
  /**
   * What each answer is scored against (FR-9.2).
   *
   * Empty is a legitimate run — timing and cost are still measured — and it is
   * what every run before this field existed was. The ceiling is there because a
   * rubric is multiplied by every cell, and a hundred checks across a hundred
   * and twenty cells is twelve thousand assertions nobody meant to ask for.
   */
  rubric: z.array(benchmarkAssertionSchema).max(20).default([]),
});
export type BenchmarkInput = z.infer<typeof benchmarkInputSchema>;

/* ---- Model Verification (B5) ---- */

export const verificationsQuerySchema = searchQuerySchema;
export type VerificationsQuery = z.infer<typeof verificationsQuerySchema>;

export const verificationsResponseSchema = pageSchema(verificationResultSchema);
export type VerificationsResponse = z.infer<typeof verificationsResponseSchema>;

export const verificationInputSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  /** The family the endpoint claims to be; the probes test this hypothesis. */
  claimedFamily: z.string().min(1),
  /**
   * How many probe requests this verification may spend (FR-10.2).
   *
   * The method is query-bounded — the single-token distribution needs tens of
   * samples per prompt to mean anything — so the budget is a real parameter
   * rather than a timeout. `quick` is for a first look at an endpoint that may
   * not answer at all; `deep` is for a verdict an operator is going to act on.
   * The floor is not here: too few usable probes is a *verdict* (`insufficient`),
   * not a validation error, because running one and being told the evidence was
   * thin is a better answer than being refused the run.
   */
  budget: probeBudgetSchema.default('standard'),
});
export type VerificationInput = z.infer<typeof verificationInputSchema>;

/* ---- Model Verification: calibration ---- */

/**
 * Measuring a reference distribution from an endpoint the operator trusts.
 *
 * The subject is what the measurement is *filed under*: a family name gives a
 * family baseline, a model id gives a model baseline, and the difference is what
 * the `match` and `family-only` verdicts mean — a family baseline can confirm the
 * family but never the exact model. The endpoint is what it is measured *from*,
 * and the two are separate on purpose: an operator calibrates `anthropic` by
 * probing one Claude endpoint they trust, and later calibrates
 * `claude-3-opus-20240229` from the same one.
 */
export const calibrationInputSchema = z.object({
  subject: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  budget: probeBudgetSchema.default('standard'),
});
export type CalibrationInput = z.infer<typeof calibrationInputSchema>;

/** One probe's reference distribution, as the console reads it. */
export const baselineEntrySchema = z.object({
  probeId: z.string(),
  /** Token → share, summing to about 1. */
  distribution: z.record(z.string(), z.number()),
  samples: z.number().int().nonnegative(),
});

/** What rutekit has a reference for, per subject. */
export const baselineSubjectSchema = z.object({
  subject: z.string(),
  /** True when the subject names a family rather than one exact model. */
  family: z.boolean(),
  probes: z.array(baselineEntrySchema),
  calibratedAt: isoDateTimeSchema,
  /** The endpoint the reference was measured from, for the record. */
  measuredFrom: z.object({ providerId: z.string(), model: z.string() }),
});

export const baselinesResponseSchema = z.object({
  subjects: z.array(baselineSubjectSchema),
  /** The families the probes know how to discriminate between. */
  knownFamilies: z.array(z.string()),
});
export type BaselinesResponse = z.infer<typeof baselinesResponseSchema>;
export type BaselineSubject = z.infer<typeof baselineSubjectSchema>;

/* ---- Tools: Dot Trick (B6) ---- */

export const dotTrickBodySchema = z.object({
  email: z.email(),
  mode: z.enum(['dot', 'plus', 'both']).default('both'),
  /**
   * Cap on generated variants. `0` means no cap: every address the chosen mode
   * can spell is returned. The ceiling is still enforced so a request cannot ask
   * for an unbounded amount of work, but it is the contract's, not the caller's.
   */
  limit: z.number().int().nonnegative().max(512).default(0),
});
export type DotTrickBody = z.infer<typeof dotTrickBodySchema>;

export const dotTrickResultSchema = z.object({
  input: z.string(),
  localPart: z.string(),
  domain: z.string(),
  variants: z.array(z.object({ address: z.string(), technique: z.enum(['dot', 'plus']) })),
  /** True when the cap cut the list short. */
  truncated: z.boolean(),
});
export type DotTrickResult = z.infer<typeof dotTrickResultSchema>;

/* ---- Tools: VCC Pool (B6) ---- */

export const vccCardsQuerySchema = searchQuerySchema.extend({
  brand: vccBrandSchema.nullable().default(null),
  status: vccCardStatusSchema.nullable().default(null),
});
export type VccCardsQuery = z.infer<typeof vccCardsQuerySchema>;

export const vccCardsResponseSchema = pageSchema(vccCardSchema);
export type VccCardsResponse = z.infer<typeof vccCardsResponseSchema>;

/**
 * The issuer ranges a batch can be minted under.
 *
 * Deliberately not paged: it is a short curated list and the picker wants all of
 * it at once, so a cursor would be ceremony with nothing behind it.
 */
export const vccBinsResponseSchema = z.object({ bins: z.array(vccBinSchema) });
export type VccBinsResponse = z.infer<typeof vccBinsResponseSchema>;

export const vccGenerateBodySchema = z.object({
  brand: vccBrandSchema.default('visa'),
  count: z.number().int().positive().max(100).default(10),
  /**
   * The issuer range to mint under. `null` lets the generator pick the
   * best-accepted range for `brand`.
   *
   * There is no country field: a range already belongs to one, and letting the
   * two be chosen independently is how a batch ends up claiming a US BIN with a
   * German country on it.
   */
  bin: z.string().nullable().default(null),
  holderName: z.string().nullable().default(null),
});
export type VccGenerateBody = z.infer<typeof vccGenerateBodySchema>;

export const vccGenerateResultSchema = z.object({ cards: z.array(vccCardSchema) });
export type VccGenerateResult = z.infer<typeof vccGenerateResultSchema>;

export const vccCardUpdateSchema = z.object({
  status: vccCardStatusSchema.optional(),
  assignedTo: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type VccCardUpdate = z.infer<typeof vccCardUpdateSchema>;

/* ---- Tools: Content Filters (B6) ---- */

export const filterRulesResponseSchema = pageSchema(filterRuleSchema);
export type FilterRulesResponse = z.infer<typeof filterRulesResponseSchema>;

export const filterRuleInputSchema = z.object({
  name: z.string().min(1).max(64),
  kind: z.enum(['regex', 'exact']),
  pattern: z.string().min(1),
  action: z.enum(['block', 'redact']),
  /** Phase 1 runs before compression, phase 2 after (FR-11.3). */
  phase: z.union([z.literal(1), z.literal(2)]),
  enabled: z.boolean().default(true),
});
export type FilterRuleInput = z.infer<typeof filterRuleInputSchema>;

export const filterRuleUpdateSchema = updateSchema(filterRuleInputSchema.shape);
export type FilterRuleUpdate = z.infer<typeof filterRuleUpdateSchema>;
