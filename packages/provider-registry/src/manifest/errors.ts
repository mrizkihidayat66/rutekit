import { z } from 'zod';

/**
 * The four causes a failed call can have, named for what they mean rather than
 * for what rutekit does about them.
 *
 * The mapping to account state is the pool's business, not the manifest's: a
 * rate limit parks an account in `rate_limited`, a spent quota in `exhausted`, a
 * rejected credential in `disabled`, and everything transient in `error` for a
 * retry to collect. Naming the classes after the states would tie a provider
 * definition to the state machine, and the same 401 means "expired" for one
 * provider and "banned" for another.
 */
export const errorClassSchema = z.enum(['rate_limit', 'quota', 'auth', 'transient']);

/**
 * What a limit is attached to, which decides who backs off.
 *
 * Most limits follow the credential, and rotating to another account answers
 * them. Some follow the address the request came from — a free tier that counts
 * by egress IP — and rotating makes those worse, because every account in the
 * pool shares the address that was throttled. A rule that is `egress`-scoped
 * therefore parks the provider rather than the account.
 */
export const errorScopeSchema = z.enum(['credential', 'egress']);

/**
 * One provider's rule for recognizing a class of failure.
 *
 * Both halves are matched and either can fire: `statuses` catches the provider
 * that answers 429, `matches` catches the one that answers 200 with an error
 * object in the body, which several of them do. Order matters, because the first
 * rule that matches wins — a provider's specific rule belongs before a general
 * one, and the registry keeps the order the manifest declares.
 *
 * A rule with neither a status nor a pattern is rejected: it would match every
 * response and swallow the ones that follow it.
 */
export const errorRuleSchema = z
  .object({
    class: errorClassSchema,
    scope: errorScopeSchema.default('credential'),
    statuses: z.array(z.number().int().min(100).max(599)).default([]),
    /** Substrings looked for in the response body or message, case-insensitive. */
    matches: z.array(z.string().min(1)).default([]),
  })
  .refine((rule) => rule.statuses.length > 0 || rule.matches.length > 0, {
    message: 'a rule must match on a status, a pattern, or both',
  });

export type ErrorClass = z.infer<typeof errorClassSchema>;
export type ErrorScope = z.infer<typeof errorScopeSchema>;
export type ErrorRule = z.infer<typeof errorRuleSchema>;
