import { z } from 'zod';
import { apiErrorSchema } from '../canonical.ts';
import { paginationQuerySchema, sortDirectionSchema } from '../common.ts';

/**
 * Primitives the control plane shares. These are deliberately separate from the
 * `/v1` surface helpers in `surfaces/common.ts`: the data plane answers in the
 * OpenAI dialect (flat `prompt_tokens`, `{ error: { message, type } }`), while the
 * console answers in rutekit's own shape. A client SDK should never see the
 * console's envelopes, and vice versa.
 */

/** Success envelope for a mutation that has no body of its own to return. */
export const okSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof okSchema>;

/** The console's error envelope — the same `apiErrorSchema` the data plane uses. */
export const consoleErrorSchema = z.object({ error: apiErrorSchema });
export type ConsoleError = z.infer<typeof consoleErrorSchema>;

/**
 * Pagination plus a sort field and direction. Every list endpoint accepts this,
 * so the table components can share one query builder.
 */
export const listQuerySchema = paginationQuerySchema.extend({
  /** Field name to sort by; null means the endpoint's natural order. */
  sort: z.string().nullable().default(null),
  direction: sortDirectionSchema.default('desc'),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/** A list page narrowed by free text — the shape most catalog views share. */
export const searchQuerySchema = listQuerySchema.extend({
  q: z.string().default(''),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
type OptionalShape<T extends z.ZodRawShape> = {
  [K in keyof T]: z.ZodOptional<WithoutDefault<T[K]>>;
};

/**
 * The PATCH shape of an input object: every field optional, and no field's
 * default applied.
 *
 * `partial()` alone is not enough, and the failure is quiet. Under Zod 4 a field
 * declared `z.array(z.string()).default([])` still yields `[]` when the key is
 * absent from the object, so a PATCH body of `{ name }` parses to
 * `{ name, modelsAllowed: [], ... }` — "rename this" would silently reset every
 * defaulted field the caller never mentioned. On an update, absent means leave
 * alone, which is the exact opposite of a default, so the defaults are dropped
 * before the field is made optional.
 */
export function updateSchema<T extends z.ZodRawShape>(shape: T): z.ZodObject<OptionalShape<T>> {
  // `ZodRawShape`'s declared value type is the core `$ZodType`, which carries no
  // builder methods; what is actually in the shape is a classic schema, which
  // has them. The cast is the whole of the difference between the two.
  const declared = shape as unknown as Record<string, z.ZodTypeAny>;
  const fields: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(declared)) {
    const inner: z.ZodTypeAny =
      field instanceof z.ZodDefault ? (field.unwrap() as z.ZodTypeAny) : field;
    fields[key] = inner.optional();
  }
  return z.object(fields as OptionalShape<T>);
}

/**
 * Result of a bulk mutation. Partial success is normal (one bad row in a paste
 * of fifty), so the failures are reported per id rather than as one error.
 */
export const bulkResultSchema = z.object({
  requested: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errors: z.array(z.object({ id: z.string(), message: z.string() })).default([]),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;
