import type { HttpHandler } from 'msw';

import { automationHandlers } from './automation.ts';
import { benchmarkHandlers } from './benchmark.ts';
import { chatHandlers } from './chat.ts';
import { overviewHandlers } from './overview.ts';
import { providerHandlers } from './providers.ts';
import { routingHandlers } from './routing.ts';
import { studioHandlers } from './studio.ts';
import { systemHandlers } from './system.ts';
import { toolHandlers } from './tools.ts';
import { verificationHandlers } from './verification.ts';

/**
 * Every control-plane handler, in the order a request should be matched against
 * it.
 *
 * The modules are grouped by the page section that owns them, which is why they
 * arrive as separate arrays — but the switch that turns mocks on is all-or-
 * nothing (see `mock-mode.ts`), so they are flattened into one list here rather
 * than kept addressable per section. A per-section list would only be useful to
 * a per-section switch, and there is no longer one.
 *
 * Order matters where two routes could match the same request: MSW resolves in
 * registration order, so the more specific paths are listed before the
 * collection they belong to (e.g. `/jobs/:id/control` before `/jobs/:id`). The
 * modules below already keep their own specific-before-general ordering.
 */
export const handlers: HttpHandler[] = [
  ...overviewHandlers,
  ...providerHandlers,
  ...routingHandlers,
  ...automationHandlers,
  ...chatHandlers,
  ...studioHandlers,
  ...benchmarkHandlers,
  ...verificationHandlers,
  ...toolHandlers,
  ...systemHandlers,
];
