import { describe, expect, it } from 'vitest';

import { handlers } from '@web/mocks/handlers/index.ts';

/**
 * A behavioural smoke test over the whole mock API.
 *
 * Every handler builds its body through `respond`, which parses the result with
 * the contract's own schema and answers 500 when it does not fit. So "this route
 * returns 200" is not a weak assertion here — it is the assertion that the
 * fixtures, the mock database and the handler together produce exactly the shape
 * `packages/contracts` promises, for that route.
 *
 * The route list is read from the handlers themselves rather than written out,
 * so a route added later is covered the moment it exists. Parameterless GETs are
 * the ones that need no request body; routes with an `:id` are exercised by the
 * page tests that navigate to them.
 */

const origin = window.location.origin;

const listable = handlers
  .filter((handler) => String(handler.info.method).toUpperCase() === 'GET')
  .map((handler) => String(handler.info.path))
  .filter((path) => !path.includes(':'));

describe('mock api', () => {
  it('has parameterless GET routes to sweep', () => {
    // Without this, a change to the filter could empty the list and the sweep
    // below would pass by doing nothing.
    expect(listable.length).toBeGreaterThan(10);
  });

  it('answers every parameterless GET with a contract-valid body', async () => {
    const failures: string[] = [];
    for (const path of listable) {
      const response = await fetch(`${origin}${path}`);
      if (response.status !== 200) {
        const body = await response.text();
        failures.push(`${path} → ${response.status} ${body.slice(0, 240)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
