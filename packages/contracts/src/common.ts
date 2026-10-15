import { z } from 'zod';

/**
 * ISO-8601 date-time string. Validated by parsing rather than by regex so that
 * both `2026-10-11T09:00:00Z` and explicit-offset forms are accepted.
 */
export const isoDateTimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'must be an ISO-8601 date-time',
});
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

export const idSchema = z.string().min(1);
export type Id = z.infer<typeof idSchema>;

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a kebab-case slug');
export type Slug = z.infer<typeof slugSchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/** Cursor pagination envelope shared by every list endpoint. */
export const paginationQuerySchema = z.object({
  cursor: z.string().nullable().default(null),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Build the response envelope for a list endpoint.
 * `total` is the count matching the current filter, not the page size.
 */
export function pageSchema<TItem extends z.ZodType>(item: TItem) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative(),
  });
}

/** Health of any long-lived subsystem shown in the UI. */
export const healthStateSchema = z.enum(['healthy', 'degraded', 'down', 'unknown']);
export type HealthState = z.infer<typeof healthStateSchema>;

/** Time window used by usage charts and quota views. */
export const timeWindowSchema = z.enum(['1h', '6h', '12h', '24h', '7d', '30d', 'all']);
export type TimeWindow = z.infer<typeof timeWindowSchema>;

export const TIME_WINDOWS = timeWindowSchema.options;

/** Milliseconds represented by each window; `all` has no fixed span. */
export const TIME_WINDOW_MS: Record<Exclude<TimeWindow, 'all'>, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
