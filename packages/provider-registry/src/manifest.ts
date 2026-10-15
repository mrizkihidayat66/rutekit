import {
  providerCapabilitiesSchema,
  providerCategorySchema,
  slugSchema,
  wireFamilySchema,
} from '@contracts';
import { z } from 'zod';

import { automationSchema } from './manifest/automation.ts';
import { authSchema } from './manifest/auth.ts';
import { discoverySchema } from './manifest/discovery.ts';
import { endpointSchema } from './manifest/endpoint.ts';
import { errorRuleSchema } from './manifest/errors.ts';
import { quotaPolicySchema } from './manifest/quota.ts';

/**
 * The four things a model can do, as a manifest states them.
 *
 * Flat and defaulted, unlike the nested block the API serves: a manifest lists
 * hundreds of models and most of them support none of this, so every flag
 * defaulting to false is what keeps an entry down to the two fields that matter.
 * The registry groups them back into the read model's shape.
 */
export const modelFlagsSchema = z.object({
  vision: z.boolean().default(false),
  tools: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  embedding: z.boolean().default(false),
});

/**
 * One model in a provider's curated list.
 *
 * `id` is the string the provider itself expects on the wire, because rutekit
 * cannot guess what an endpoint calls its models and an alias is a routing
 * concern, not a definition one. `upstreamId` and `wireFamily` exist for the
 * handful of providers that serve one catalogue over more than one endpoint: an
 * entry can point at a different id, or speak a different dialect, without
 * becoming a second provider.
 */
export const manifestModelSchema = z.object({
  id: z.string().min(1),
  /** What the console shows; empty falls back to the id. */
  displayName: z.string().default(''),
  contextWindow: z.number().int().positive().nullable().default(null),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  capabilities: modelFlagsSchema.prefault({}),
  /** USD per million tokens; null when the provider does not price per token. */
  inputPricePerMTok: z.number().nonnegative().nullable().default(null),
  outputPricePerMTok: z.number().nonnegative().nullable().default(null),
  deprecated: z.boolean().default(false),
  /** Upstream id when it differs from `id`; null when they are the same. */
  upstreamId: z.string().min(1).nullable().default(null),
  /** Wire family when this model speaks a different one; null inherits the provider's. */
  wireFamily: wireFamilySchema.nullable().default(null),
});

/**
 * One provider, as rutekit ships it.
 *
 * The whole of what the v1 catalogue knows about a provider, and the only place
 * it knows it. Everything else — the console's catalog page, the model list, the
 * connection probe, the quota sweep — reads a manifest and derives its view,
 * which is what keeps a provider from being described in two places that then
 * disagree (ADR-0006).
 *
 * Grouped by concern, in the order a reader asks the questions: what is it, where
 * is it, how do we get in, what can it do, which models, how much is left, what
 * does a failure mean, and how does an account get created. Each group has its
 * own schema and its own file, so a change to how quota works is a change to one
 * small file rather than to a wall of definition.
 *
 * `capabilities` is the one block that is not new here: it is the API's own
 * vocabulary, imported so a manifest cannot claim a capability the console has no
 * field to show. Agreeing on the shape is not agreeing on the values, so the
 * registry still checks the flags against the rest of the manifest — an `oauth`
 * flag over a list of auth modes that contains no sign-in is a contradiction,
 * not a typo.
 */
export const providerManifestSchema = z.object({
  // --- identity ---
  id: slugSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  category: providerCategorySchema,
  /** Icon slug the console's icon map resolves; never a URL. */
  icon: z.string().min(1),
  docsUrl: z.url().nullable().default(null),
  /** Whether the catalogue files this under "free" — a membership, not a price. */
  freeTier: z.boolean().default(false),

  // --- endpoint & wire ---
  endpoint: endpointSchema,

  // --- how we get in ---
  /**
   * Every way an account can be added, in preference order.
   *
   * A list rather than one mode, because several providers accept more than one:
   * a coding agent that signs in through a browser *and* takes a pasted key, or a
   * first-party API that offers OAuth alongside its keys. The order is the
   * console's default, and the registry checks the list against the `oauth`
   * capability so the two cannot disagree about whether a sign-in exists.
   */
  authModes: z.array(authSchema).min(1),

  // --- what it can do ---
  capabilities: providerCapabilitiesSchema,

  // --- which models ---
  discovery: discoverySchema,
  /** The curated list a fresh install starts from, before any discovery runs. */
  models: z.array(manifestModelSchema).default([]),

  // --- how much is left ---
  quota: quotaPolicySchema,

  // --- what a failure means ---
  /** First rule that matches wins, so the order here is load-bearing. */
  errors: z.array(errorRuleSchema).default([]),

  // --- how an account is created ---
  automation: automationSchema.nullable().default(null),
});

/** What the registry hands out: every default applied, every field present. */
export type ProviderManifest = z.infer<typeof providerManifestSchema>;

/**
 * What a provider file writes: the same shape with the optional fields optional.
 *
 * Provider files are typed against this rather than against `ProviderManifest`,
 * so a manifest states only what it decides and lets the schema fill the rest —
 * which is the whole point of the defaults. The registry parses the input list,
 * and that parse is what makes the difference real rather than a type assertion.
 */
export type ProviderManifestInput = z.input<typeof providerManifestSchema>;

export type ManifestModel = z.infer<typeof manifestModelSchema>;
export type ModelFlags = z.infer<typeof modelFlagsSchema>;
