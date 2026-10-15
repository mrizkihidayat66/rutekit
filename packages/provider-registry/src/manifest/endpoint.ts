import { wireFamilySchema } from '@contracts';
import { z } from 'zod';

/**
 * A provider whose endpoint or credential is region-specific.
 *
 * The region is not a constant: it is chosen per account, and the same provider
 * reached through a different region is a different upstream. `placement` says
 * where the value has to appear for the request to land correctly — inside an
 * assembled host, as a query parameter, or in the body — because a provider that
 * wants it in one place rejects it in the others.
 */
export const regionSchema = z.object({
  values: z.array(z.string().min(1)).min(1),
  default: z.string().min(1),
  placement: z.enum(['host', 'query', 'body']),
  /** The parameter name for `query`/`body`; null when the region sits in the host. */
  param: z.string().min(1).nullable().default(null),
});

/**
 * Where a provider lives, and the parts of a request that are the same for every
 * caller.
 *
 * A provider has either a literal `baseUrl` or a `baseUrlTemplate` whose
 * placeholders an account's own config resolves. Vertex is what forces the second
 * form: its host carries both a region and a project, so there is no one URL to
 * write down. Exactly one of the two must be set — a rule about a pair of fields,
 * which a schema cannot state, so the registry's construction check enforces it.
 *
 * `headers` and `queryParams` are static by design. Anything that varies per
 * request belongs to the wire translator; anything that varies per account
 * belongs to the account. What is left here is the provider's own price of
 * admission — an attribution header, a required user agent, a gating parameter.
 */
export const endpointSchema = z.object({
  /** The endpoint, or null when it is assembled per account from the template. */
  baseUrl: z.url().nullable(),
  /** A URL with `{placeholders}` an account's own config resolves. */
  baseUrlTemplate: z.string().min(1).nullable().default(null),
  wireFamily: wireFamilySchema,
  /** Path appended to the base for chat traffic; null takes the wire default. */
  chatPath: z.string().min(1).nullable().default(null),
  headers: z.record(z.string(), z.string()).default({}),
  queryParams: z.record(z.string(), z.string()).default({}),
  regions: regionSchema.nullable().default(null),
});

export type Endpoint = z.infer<typeof endpointSchema>;
export type Region = z.infer<typeof regionSchema>;
