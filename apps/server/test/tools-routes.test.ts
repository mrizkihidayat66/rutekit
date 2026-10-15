import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  consoleErrorSchema,
  consolePaths,
  dotTrickResultSchema,
  filterRulesResponseSchema,
  okSchema,
  vccCardsResponseSchema,
  vccGenerateResultSchema,
  vccRevealResultSchema,
  vccCardSchema,
} from '@contracts';
import type { VccCard, VccBin } from '@contracts';

import { buildApp } from '@server/app.ts';
import { passesLuhn } from '@server/tools/luhn.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The Tools console (C8, FR-11.1–11.3).
 *
 * Route-level over the real composition. The three features share a page and
 * almost nothing else, so each is exercised on its own terms: the dot trick is a
 * pure calculation with no state, the card pool is a ledger with a secret behind
 * each row, and the filters are rules the data plane reads on every turn.
 *
 * The assertion worth naming is the card one. The read model promises the number
 * is write-only, and a route test is where "the list never returns a PAN" is
 * worth pinning — the same rule the account and API-key suites pin.
 */

const PASSWORD = 'correct-horse-battery';
const KEY_HEX = 'ab'.repeat(32);

type App = ReturnType<typeof buildApp>;

async function signIn(app: App): Promise<string> {
  const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authSetup}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, instanceName: 'Test' }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup did not set a session cookie');
  const pair = setCookie.split(';')[0];
  if (pair === undefined) throw new Error('empty set-cookie header');
  return pair;
}

async function call(
  app: App,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return app.request(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

function pathOf(template: string, id: string): string {
  return `${CONSOLE_API_PREFIX}${template.replace(':id', id)}`;
}

const DOT_PATH = `${CONSOLE_API_PREFIX}${consolePaths.dotTrick}`;
const VCC_PATH = `${CONSOLE_API_PREFIX}${consolePaths.vccCards}`;
const VCC_BINS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.vccBins}`;
const VCC_GENERATE_PATH = `${CONSOLE_API_PREFIX}${consolePaths.vccGenerate}`;
const FILTERS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.filterRules}`;

const FILTER_INPUT = {
  name: 'no-secrets',
  kind: 'exact',
  pattern: 'hunter2',
  action: 'block',
  phase: 1,
  enabled: true,
};

let server: TestServer;
let app: App;
let cookie: string;

beforeEach(async () => {
  server = makeServer({ secrets: new SecretBox(KEY_HEX) });
  server.lifecycle.markReady();
  app = buildApp(server);
  cookie = await signIn(app);
});

afterEach(() => {
  server.close();
});

describe('the session guard', () => {
  it('refuses the tools routes without a session', async () => {
    for (const path of [DOT_PATH, VCC_PATH, FILTERS_PATH]) {
      const response = await call(app, path, { method: path === DOT_PATH ? 'POST' : 'GET' });
      expect(response.status, path).toBe(401);
    }
  });
});

describe('the dot trick', () => {
  it('expands an address into both techniques', async () => {
    const response = await call(app, DOT_PATH, {
      method: 'POST',
      body: { email: 'alice@example.com', mode: 'both', limit: 0 },
      cookie,
    });

    expect(response.status).toBe(200);
    const result = dotTrickResultSchema.parse(await response.json());
    expect(result.localPart).toBe('alice');
    expect(result.domain).toBe('example.com');
    // Four gaps, so fifteen dot spellings plus the five plus tags.
    expect(result.variants).toHaveLength(20);
    expect(result.variants.some((entry) => entry.technique === 'dot')).toBe(true);
    expect(result.variants.some((entry) => entry.technique === 'plus')).toBe(true);
  });

  it('honours a limit and says it truncated', async () => {
    const response = await call(app, DOT_PATH, {
      method: 'POST',
      body: { email: 'alice@example.com', mode: 'both', limit: 3 },
      cookie,
    });

    const result = dotTrickResultSchema.parse(await response.json());
    expect(result.variants).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('refuses something that is not an address', async () => {
    const response = await call(app, DOT_PATH, {
      method: 'POST',
      body: { email: 'not-an-address', mode: 'both', limit: 0 },
      cookie,
    });

    expect(response.status).toBe(400);
  });

  it('refuses an unknown mode', async () => {
    const response = await call(app, DOT_PATH, {
      method: 'POST',
      body: { email: 'a@b.co', mode: 'everything', limit: 0 },
      cookie,
    });
    expect(response.status).toBe(400);
  });
});

describe('the card pool', () => {
  it('lists the issuer ranges', async () => {
    const response = await call(app, VCC_BINS_PATH, { cookie });
    expect(response.status).toBe(200);

    const { bins } = (await response.json()) as { bins: VccBin[] };
    expect(bins.length).toBeGreaterThan(5);
    expect(bins.some((bin) => bin.brand === 'visa')).toBe(true);
  });

  it('mints a batch of Luhn-valid cards', async () => {
    const response = await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 3, bin: null, holderName: 'A Person' },
      cookie,
    });

    expect(response.status).toBe(201);
    const { cards } = vccGenerateResultSchema.parse(await response.json());
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.brand).toBe('visa');
      expect(card.status).toBe('active');
      expect(card.holderName).toBe('A Person');
      // A card that fails Luhn is not a card, it is a string.
      expect(card.hasPan).toBe(true);
      expect(card.maskedNumber).toContain(card.last4);
    }
  });

  it('never puts a full number in a read model', async () => {
    await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 2, bin: null, holderName: null },
      cookie,
    });

    const page = vccCardsResponseSchema.parse(
      await (await call(app, VCC_PATH, { cookie })).json(),
    );

    // The list is a ledger: a BIN, a masked form and a last four. A console that
    // carried every number would be a cardholder-data store with a UI.
    for (const card of page.items) {
      expect(card).not.toHaveProperty('pan');
      expect(card.maskedNumber).toContain('•');
    }
  });

  it('reveals the number for one card, and it passes its own check', async () => {
    const created = await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 1, bin: null, holderName: null },
      cookie,
    });
    const { cards } = vccGenerateResultSchema.parse(await created.json());
    const card = cards[0] as VccCard;

    const response = await call(app, pathOf(consolePaths.vccReveal, card.id), { cookie });

    expect(response.status).toBe(200);
    const revealed = vccRevealResultSchema.parse(await response.json());
    // The whole point: the number the pool minted is a number that checks out.
    expect(passesLuhn(revealed.pan)).toBe(true);
    expect(revealed.pan.slice(-4)).toBe(card.last4);
    expect(revealed.pan.startsWith(card.bin)).toBe(true);
    expect(revealed.formatted.replace(/\D/gu, '')).toBe(revealed.pan);
    expect(revealed.cvv.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a reveal for a card with no number stored', async () => {
    const created = await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 1, bin: null, holderName: null },
      cookie,
    });
    const { cards } = vccGenerateResultSchema.parse(await created.json());
    const card = cards[0] as VccCard;

    // Simulate a card recorded by hand from a masked form: it has no envelope.
    server.persistence.sqlite
      .query('update vcc_cards set has_pan = 0, pan_envelope = null where id = ?')
      .run(card.id);

    const response = await call(app, pathOf(consolePaths.vccReveal, card.id), { cookie });
    // Refused rather than answered with an empty string, so a UI can hide the
    // button instead of showing a card with no digits.
    expect(response.status).toBe(400);
  });

  it('refuses a BIN that does not belong to the brand', async () => {
    const response = await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 1, bin: '378282', holderName: null },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('not a visa range');
  });

  it('refuses an unknown BIN', async () => {
    const response = await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 1, bin: '999999', holderName: null },
      cookie,
    });
    expect(response.status).toBe(400);
  });

  it('moves a card through its lifecycle and refuses the moves that would reopen it', async () => {
    const created = await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 1, bin: null, holderName: null },
      cookie,
    });
    const { cards } = vccGenerateResultSchema.parse(await created.json());
    const card = cards[0] as VccCard;
    const cardPath = pathOf(consolePaths.vccCard, card.id);

    const reserved = await call(app, cardPath, {
      method: 'PATCH',
      body: { status: 'reserved', assignedTo: 'codebuddy signup' },
      cookie,
    });
    expect(vccCardSchema.parse(await reserved.json()).status).toBe('reserved');

    const used = await call(app, cardPath, { method: 'PATCH', body: { status: 'used' }, cookie });
    expect(vccCardSchema.parse(await used.json()).status).toBe('used');

    // A spent card that went back to `active` would be handed to the next sign-up,
    // which is the one thing the lifecycle exists to prevent.
    const reopened = await call(app, cardPath, {
      method: 'PATCH',
      body: { status: 'active' },
      cookie,
    });
    expect(reopened.status).toBe(400);
    expect((await errorOf(reopened)).message).toContain('cannot become');
  });

  it('lets a reservation go back to active, which is what an abandoned sign-up leaves', async () => {
    const created = await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 1, bin: null, holderName: null },
      cookie,
    });
    const { cards } = vccGenerateResultSchema.parse(await created.json());
    const card = cards[0] as VccCard;
    const cardPath = pathOf(consolePaths.vccCard, card.id);

    await call(app, cardPath, { method: 'PATCH', body: { status: 'reserved' }, cookie });
    const released = await call(app, cardPath, {
      method: 'PATCH',
      body: { status: 'active' },
      cookie,
    });

    expect(vccCardSchema.parse(await released.json()).status).toBe('active');
  });

  it('filters by brand and status', async () => {
    await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'amex', count: 2, bin: null, holderName: null },
      cookie,
    });
    await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 1, bin: null, holderName: null },
      cookie,
    });

    const amex = vccCardsResponseSchema.parse(
      await (await call(app, `${VCC_PATH}?brand=amex`, { cookie })).json(),
    );
    expect(amex.total).toBe(2);

    const active = vccCardsResponseSchema.parse(
      await (await call(app, `${VCC_PATH}?status=active`, { cookie })).json(),
    );
    expect(active.total).toBe(3);
  });

  it('deletes a card', async () => {
    const created = await call(app, VCC_GENERATE_PATH, {
      method: 'POST',
      body: { brand: 'visa', count: 1, bin: null, holderName: null },
      cookie,
    });
    const { cards } = vccGenerateResultSchema.parse(await created.json());
    const card = cards[0] as VccCard;

    const response = await call(app, pathOf(consolePaths.vccCard, card.id), {
      method: 'DELETE',
      cookie,
    });

    expect(okSchema.parse(await response.json()).ok).toBe(true);
    expect(server.vccCards.findById(card.id)).toBeNull();
  });

  it('answers not_found for a card that does not exist', async () => {
    const response = await call(app, pathOf(consolePaths.vccCard, 'nope'), { cookie });
    expect(response.status).toBe(404);
  });
});

describe('the content filter rules', () => {
  it('creates a rule and reads it back', async () => {
    const response = await call(app, FILTERS_PATH, {
      method: 'POST',
      body: FILTER_INPUT,
      cookie,
    });

    expect(response.status).toBe(201);
    const rule = (await response.json()) as { name: string; phase: number };
    expect(rule.name).toBe('no-secrets');
    expect(rule.phase).toBe(1);
  });

  it('lists the rules in phase order', async () => {
    await call(app, FILTERS_PATH, {
      method: 'POST',
      body: { ...FILTER_INPUT, name: 'second-phase', phase: 2 },
      cookie,
    });
    await call(app, FILTERS_PATH, {
      method: 'POST',
      body: { ...FILTER_INPUT, name: 'first-phase', phase: 1 },
      cookie,
    });

    const page = filterRulesResponseSchema.parse(
      await (await call(app, FILTERS_PATH, { cookie })).json(),
    );

    // Phase 1 before phase 2 whatever order they were created in, because that is
    // the order the pipeline runs them.
    expect(page.items.map((rule) => rule.name)).toEqual(['first-phase', 'second-phase']);
  });

  it('edits a rule', async () => {
    const created = await call(app, FILTERS_PATH, { method: 'POST', body: FILTER_INPUT, cookie });
    const rule = (await created.json()) as { id: string };

    const response = await call(app, pathOf(consolePaths.filterRule, rule.id), {
      method: 'PATCH',
      body: { action: 'redact' },
      cookie,
    });

    const updated = (await response.json()) as { action: string; pattern: string };
    expect(updated.action).toBe('redact');
    // A patch that named one field leaves the rest alone.
    expect(updated.pattern).toBe('hunter2');
  });

  it('deletes a rule', async () => {
    const created = await call(app, FILTERS_PATH, { method: 'POST', body: FILTER_INPUT, cookie });
    const rule = (await created.json()) as { id: string };

    const response = await call(app, pathOf(consolePaths.filterRule, rule.id), {
      method: 'DELETE',
      cookie,
    });

    expect(okSchema.parse(await response.json()).ok).toBe(true);
    expect(server.filterRules.findById(rule.id)).toBeNull();
  });

  it('refuses an unknown phase', async () => {
    const response = await call(app, FILTERS_PATH, {
      method: 'POST',
      body: { ...FILTER_INPUT, phase: 3 },
      cookie,
    });
    expect(response.status).toBe(400);
  });
});
