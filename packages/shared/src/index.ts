/**
 * @rutekit/shared — pure utilities with no I/O, usable from either side of the
 * frontend/backend boundary.
 *
 * Two rules keep it that way, and both are checkable rather than aspirational:
 * nothing here imports `node:*` or `bun:*`, and nothing reaches for an ambient
 * global. Where a capability would need one — randomness, a clock — the function
 * takes it as an argument instead. That is what lets every file here be exercised
 * with no runtime standing behind it.
 */

export * from './ids.ts';
export * from './sse.ts';
