/**
 * @rutekit/contracts — the single bridge between frontend and backend.
 *
 * RULESET R0.1: this package is the only place a web file and a server file may
 * both import from. It must stay free of runtime dependencies beyond Zod and
 * must never import from `apps/*`.
 *
 * Every exported type is *derived* from its Zod schema with `z.infer`; no shape
 * is ever declared twice (R1.6). The parity test enforces that pairing.
 */

export * from './api/index.ts';
export * from './canonical.ts';
export * from './common.ts';
export * from './entities/index.ts';
export * from './surfaces/index.ts';
export * from './worker-protocol.ts';
export * from './ws.ts';
