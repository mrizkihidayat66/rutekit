import { z } from 'zod';

import type { Discovery } from './manifest/discovery.ts';

/**
 * Reading a provider's model list, one dialect at a time.
 *
 * The three listings answer the same question in three shapes, and none of them
 * is the shape rutekit stores. Each schema below is deliberately narrow — it asks
 * for the id and whatever the provider happens to say about size — because a
 * listing is a claim about what exists, not about what a model can do. Anything
 * rutekit already knows about an id comes from the manifest, and is merged in by
 * the caller rather than read off the wire.
 *
 * A listing that does not parse is not an error. `parseListing` answers null, and
 * the caller turns that into an empty list and a sentence, because a provider
 * that changes its envelope should degrade to "we could not read this" rather
 * than take the catalogue down with it.
 */

/** One entry as the endpoint described it, before the manifest is consulted. */
export interface ListedModel {
  readonly id: string;
  readonly displayName: string | null;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
}

const openAiListingSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

const anthropicListingSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().min(1).optional(),
    }),
  ),
});

/** Google names a model `models/gemini-2.5-pro`; rutekit stores the bare id. */
const GOOGLE_PREFIX = 'models/';

const googleListingSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      displayName: z.string().min(1).optional(),
      inputTokenLimit: z.number().int().positive().optional(),
      outputTokenLimit: z.number().int().positive().optional(),
    }),
  ),
});

/**
 * The models an endpoint listed, or null when its answer could not be read.
 *
 * `static` never reaches here — there is no listing to ask for — but the switch
 * is exhaustive over the strategy so a fourth strategy cannot be added without
 * this file being updated to answer for it.
 */
export function parseListing(strategy: Discovery['strategy'], body: string): ListedModel[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }

  switch (strategy) {
    case 'openai': {
      const parsed = openAiListingSchema.safeParse(payload);
      if (!parsed.success) return null;
      return parsed.data.data.map((entry) => ({
        id: entry.id,
        displayName: null,
        contextWindow: null,
        maxOutputTokens: null,
      }));
    }
    case 'anthropic': {
      const parsed = anthropicListingSchema.safeParse(payload);
      if (!parsed.success) return null;
      return parsed.data.data.map((entry) => ({
        id: entry.id,
        displayName: entry.display_name ?? null,
        contextWindow: null,
        maxOutputTokens: null,
      }));
    }
    case 'google': {
      const parsed = googleListingSchema.safeParse(payload);
      if (!parsed.success) return null;
      return parsed.data.models.map((entry) => ({
        id: entry.name.startsWith(GOOGLE_PREFIX)
          ? entry.name.slice(GOOGLE_PREFIX.length)
          : entry.name,
        displayName: entry.displayName ?? null,
        contextWindow: entry.inputTokenLimit ?? null,
        maxOutputTokens: entry.outputTokenLimit ?? null,
      }));
    }
    case 'static':
      return null;
  }
}
