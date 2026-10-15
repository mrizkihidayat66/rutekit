import { setupServer } from 'msw/node';

import { handlers } from './handlers/index.ts';

/**
 * The Node mock server, for tests and for anything rendering outside a browser.
 *
 * It takes the raw handlers rather than the browser worker, which is what keeps
 * a test deterministic: no simulated latency, no scenario switch, no random
 * failure — only the handlers' own logic.
 */
export const server = setupServer(...handlers);
