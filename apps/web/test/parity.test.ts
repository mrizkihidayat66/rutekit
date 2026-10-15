import { usageBreakdownDimensionSchema } from '@contracts';
import { describe, expect, it } from 'vitest';

import { PROVIDER_ICON_SLUGS } from '@web/components/patterns/ProviderIcon.tsx';
import { handlers } from '@web/mocks/handlers/index.ts';
import { mocksEnabled } from '@web/mocks/mock-mode.ts';
import { PROVIDER_CATALOG } from '@web/mocks/fixtures/provider-catalog.ts';
import { DIMENSION_KEYS, DIMENSIONS } from '@web/routes/pages/usage/metrics.ts';

/**
 * The console's hand-maintained lists, against the contract (ROADMAP D1).
 *
 * `packages/contracts` is the single source of truth for what the API is, but
 * several things in `apps/web` are *copies* of a list the contract already
 * declares — a set of breakdown dimensions, a vocabulary of icon slugs. A copy
 * is fine; a copy that drifts is not, and
 * drift here fails quietly rather than loudly:
 *
 *   - a new breakdown dimension the contract gained and the page does not offer
 *     is a feature nobody can reach, and nothing complains;
 *   - a provider shipping an icon slug the map does not have renders a neutral
 *     box, which looks like a design choice rather than a missing glyph;
 *   - the mock layer turning itself on by default would mean the console a
 *     developer sees is a different console from the one an operator gets.
 *
 * Each of those is a silent degradation, which is why they are asserted rather
 * than left to review. The server's half of the same concern lives in
 * `apps/server/test/parity.test.ts`; neither side can read the other, so both
 * read the contract.
 */

describe('the usage breakdown dimensions', () => {
  it('offers every dimension the contract declares', () => {
    // Set equality in both directions: a dimension the contract gained but the
    // page never offers is unreachable, and one the page offers but the contract
    // dropped is a request the server will reject.
    expect([...DIMENSION_KEYS].sort()).toEqual([...usageBreakdownDimensionSchema.options].sort());
  });

  it('labels each one, and only once', () => {
    for (const dimension of DIMENSIONS) {
      expect(dimension.label.trim(), `${dimension.key} has no label`).not.toBe('');
    }
    const keys = DIMENSIONS.map((dimension) => dimension.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the provider icon map', () => {
  it('knows a glyph for every slug the catalogue uses', () => {
    // The fixture is the console's mirror of the shipped registry, and the two
    // use the same 28 slugs today. Asserting against the fixture is what this
    // side can see: the registry is server-only, and the boundary forbids
    // reaching for it. It catches the drift that matters — a provider added to
    // the catalogue with a glyph the console cannot draw.
    const slugs = new Set(PROVIDER_CATALOG.map((provider) => provider.icon));

    const unrenderable = [...slugs].filter((slug) => !PROVIDER_ICON_SLUGS.includes(slug));
    expect(unrenderable).toEqual([]);
  });

  it('keeps the slug vocabulary free of duplicates and blanks', () => {
    expect(PROVIDER_ICON_SLUGS.length).toBeGreaterThan(0);
    expect(new Set(PROVIDER_ICON_SLUGS).size).toBe(PROVIDER_ICON_SLUGS.length);
    expect(PROVIDER_ICON_SLUGS.filter((slug) => slug.trim() === '')).toEqual([]);
  });
});

describe('the mock layer', () => {
  it('is off unless it is asked for', () => {
    // The default this file exists to protect. Mocks were on by default through
    // FASE B, when there was no backend; now that there is one, a console that
    // silently answers from fixtures is a console that disagrees with the server
    // and says nothing about it. `VITE_MOCKS` is unset in the test environment,
    // which is exactly the case being asserted.
    expect(mocksEnabled).toBe(false);
  });

  it('still has handlers to offer when it is asked for', () => {
    // The escape hatch has to actually work, and an empty barrel would make
    // `VITE_MOCKS=on` a worker that intercepts nothing — which looks like the
    // mock layer being broken rather than absent.
    expect(handlers.length).toBeGreaterThan(20);
  });
});
