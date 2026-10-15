/**
 * @rutekit/compression — the token-saver pipeline.
 *
 * Five stages run over an outbound request, in the order the ROADMAP names them:
 * TSC (tool schemas), DCP (duplicate context), RTK (tool results), Caveman (the
 * system prompt) and Cache Markers. Each is independent, and each is fail-open:
 * a stage that throws returns its input unchanged rather than breaking the call,
 * so the worst case of a misconfiguration is that it saves nothing.
 *
 * The pipeline reads and writes the pivot request from `@translator` and performs
 * no I/O, which is what lets it be exercised without a provider or a runtime
 * standing behind it.
 */

export * from './bytes.ts';
export * from './cache-markers.ts';
export * from './caveman.ts';
export * from './config.ts';
export * from './dcp.ts';
export * from './pipeline.ts';
export * from './rtk-filters.ts';
export * from './rtk.ts';
export * from './tsc.ts';
export * from './types.ts';
