/**
 * Merging a patch over a settings record.
 *
 * The console's PATCH schemas make every field optional, and a parsed body always
 * produces `field?: T | undefined` — which under `exactOptionalPropertyTypes` is
 * *not* the same as `Partial<T>`, where an absent key is allowed but an explicit
 * `undefined` is not. The distinction matters here rather than being pedantry: a
 * body that says `{"glassDepth": null}` and one that omits `glassDepth` are
 * different requests, and only the first should be a validation error.
 *
 * So the patch type names the `undefined`, and this merge is what makes it mean
 * what it should: a key the patch left undefined leaves the stored value alone.
 * Spreading the patch directly would write `undefined` over a real value and the
 * record would fail its own schema on the next read — a settings page that erased
 * a field by not mentioning it.
 *
 * `Object.assign` rather than a loop, because assigning across a union of keys
 * cannot be expressed without an assertion, and this codebase does not use them
 * outside boundary parsing (R1.3).
 */

/** A patch over `T`: every field optional, and explicitly allowed to be undefined. */
export type PatchOf<T> = Readonly<{ [K in keyof T]?: T[K] | undefined }>;

export function mergePatch<T extends object>(base: T, patch: PatchOf<T>): T {
  const defined = Object.fromEntries(
    Object.entries(patch).filter((entry) => entry[1] !== undefined),
  );
  return Object.assign({}, base, defined);
}
