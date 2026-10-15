/**
 * The control plane (`/console/api/*`) — the dashboard's own REST surface, as
 * opposed to the `/v1/*` data plane in `../surfaces/`. Each module mirrors the
 * nav section that owns its pages, so a screen maps to one file.
 */
export * from './paths.ts';
export * from './shared.ts';
export * from './overview.ts';
export * from './providers.ts';
export * from './routing.ts';
export * from './automation.ts';
export * from './tools.ts';
export * from './system.ts';
