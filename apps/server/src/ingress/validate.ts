import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';

import { AppError } from '@server/errors.ts';

/**
 * Input validation for a JSON body (RULESET R5.1).
 *
 * `@hono/zod-validator` on its own answers a bad body with its own JSON, which
 * the console cannot read: its client builds an `ApiError` by looking for the
 * `{ error: … }` envelope and otherwise falls back to a bare "Request failed
 * with status 400". So the hook here turns a failure into an `AppError` and lets
 * the error lifecycle render it like every other failure — one envelope, one
 * shape, and a message that names the field that was actually wrong.
 */

/**
 * The shape we actually read off a Zod issue. Structural rather than `z.ZodError`
 * on purpose: the validator hands back the core error class, which is not
 * nominally the same type as the classic `z.ZodError`, and naming the fields we
 * use is both assignable from either and honest about the dependency.
 */
interface Issue {
  readonly path: ReadonlyArray<string | number | symbol>;
  readonly message: string;
}

/** The first problem, as a sentence a person can act on. */
function describe(error: { readonly issues: readonly Issue[] }): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'The request body was not valid.';
  const path = issue.path.join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

export function jsonBody<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (result) => {
    if (!result.success) throw AppError.invalidRequest(describe(result.error));
  });
}
