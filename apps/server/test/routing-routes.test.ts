import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  aliasesResponseSchema,
  combosResponseSchema,
  consoleErrorSchema,
  consolePaths,
  mappingPreviewResultSchema,
  mappingsResponseSchema,
  okSchema,
} from '@contracts';
import type { Alias, Combo, ModelMappingRule } from '@contracts';

import { buildApp } from '@server/app.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The Routing console (C5b, FR-1.3–1.5).
 *
 * Route-level over the real composition, because what is being checked only meets
 * here: the contract's query and body schemas, the services' rules about what may
 * change, and the repositories that have to keep a combo's entries in step with
 * the combo.
 *
 * The two rules worth pinning are the ones a caller cannot infer from the schema:
 * a name is fixed once it exists (the console disables the field, so the API has
 * to refuse rather than quietly ignore), and a PATCH that does not mention
 * `entries` leaves the chain alone. The second is the `updateSchema` bug from C2
 * wearing a new hat — a combo's entries are a defaulted field, so `partial()`
 * would have emptied every chain on any unrelated edit.
 */

const PASSWORD = 'correct-horse-battery';

const COMBOS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.combos}`;
const ALIASES_PATH = `${CONSOLE_API_PREFIX}${consolePaths.aliases}`;
const MAPPINGS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.mappings}`;
const PREVIEW_PATH = `${CONSOLE_API_PREFIX}${consolePaths.mappingsPreview}`;

type App = ReturnType<typeof buildApp>;

function pathOf(template: string, id: string): string {
  return `${CONSOLE_API_PREFIX}${template.replace(':id', id)}`;
}

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

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly cookie?: string;
}

async function call(app: App, path: string, options: RequestOptions = {}): Promise<Response> {
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

const COMBO_INPUT = {
  name: 'daily-driver',
  displayName: 'Daily driver',
  description: null,
  strategy: 'sequential',
  entries: [
    { model: 'gpt-4o-mini', providerId: 'openai', weight: 1, enabled: true },
    { model: 'claude-3-opus-20240229', providerId: null, weight: 2, enabled: true },
  ],
  fallbackOnError: true,
  enabled: true,
};

const ALIAS_INPUT = {
  alias: 'fast',
  target: 'gpt-4o-mini',
  providerId: null,
  description: null,
  enabled: true,
};

const MAPPING_INPUT = {
  match: 'exact',
  pattern: 'gpt-4o',
  replacement: 'gpt-4o-mini',
  priority: 0,
  description: null,
  enabled: true,
};

async function createCombo(app: App, cookie: string, body: unknown = COMBO_INPUT): Promise<Combo> {
  const response = await call(app, COMBOS_PATH, { method: 'POST', body, cookie });
  expect(response.status).toBe(201);
  return (await response.json()) as Combo;
}

async function createAlias(app: App, cookie: string, body: unknown = ALIAS_INPUT): Promise<Alias> {
  const response = await call(app, ALIASES_PATH, { method: 'POST', body, cookie });
  expect(response.status).toBe(201);
  return (await response.json()) as Alias;
}

async function createMapping(
  app: App,
  cookie: string,
  body: unknown = MAPPING_INPUT,
): Promise<ModelMappingRule> {
  const response = await call(app, MAPPINGS_PATH, { method: 'POST', body, cookie });
  expect(response.status).toBe(201);
  return (await response.json()) as ModelMappingRule;
}

let server: TestServer;
let app: App;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  server.lifecycle.markReady();
  app = buildApp(server);
  cookie = await signIn(app);
});

afterEach(() => {
  server.close();
});

describe('the session guard', () => {
  it('refuses a listing without a session', async () => {
    const response = await call(app, COMBOS_PATH);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).kind).toBe('authentication');
  });
});

describe('combos', () => {
  it('creates one with its entries in the order they were sent', async () => {
    const combo = await createCombo(app, cookie);

    expect(combo.name).toBe('daily-driver');
    expect(combo.entries.map((entry) => entry.model)).toEqual([
      'gpt-4o-mini',
      'claude-3-opus-20240229',
    ]);
    // The entry ids are rutekit's, not the caller's: the input schema has none.
    expect(combo.entries[0]?.id).toBeTruthy();
    expect(combo.entries[0]?.weight).toBe(1);
  });

  it('lists and pages', async () => {
    await createCombo(app, cookie, { ...COMBO_INPUT, name: 'a-combo' });
    await createCombo(app, cookie, { ...COMBO_INPUT, name: 'b-combo' });

    const response = await call(app, `${COMBOS_PATH}?limit=1`, { cookie });
    const page = combosResponseSchema.parse(await response.json());

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBe('1');
  });

  it('filters by free text across the name and the display name', async () => {
    await createCombo(app, cookie, { ...COMBO_INPUT, name: 'a-combo', displayName: 'Alpha' });
    await createCombo(app, cookie, { ...COMBO_INPUT, name: 'b-combo', displayName: 'Beta' });

    const response = await call(app, `${COMBOS_PATH}?q=beta`, { cookie });
    const page = combosResponseSchema.parse(await response.json());

    expect(page.items.map((combo) => combo.name)).toEqual(['b-combo']);
  });

  it('refuses a second combo with the same name', async () => {
    await createCombo(app, cookie);

    const response = await call(app, COMBOS_PATH, { method: 'POST', body: COMBO_INPUT, cookie });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('already exists');
  });

  it('replaces the chain when entries are sent', async () => {
    const combo = await createCombo(app, cookie);

    const response = await call(app, pathOf(consolePaths.combo, combo.id), {
      method: 'PATCH',
      body: { entries: [{ model: 'gpt-4o', providerId: null, weight: 3, enabled: true }] },
      cookie,
    });

    const updated = (await response.json()) as Combo;
    expect(updated.entries).toHaveLength(1);
    expect(updated.entries[0]?.model).toBe('gpt-4o');
    expect(updated.entries[0]?.weight).toBe(3);
  });

  it('leaves the chain alone when the patch does not mention it', async () => {
    const combo = await createCombo(app, cookie);

    const response = await call(app, pathOf(consolePaths.combo, combo.id), {
      method: 'PATCH',
      body: { displayName: 'Renamed' },
      cookie,
    });

    const updated = (await response.json()) as Combo;
    // `entries` is a defaulted field, so `partial()` would have emptied it here —
    // a rename would have silently destroyed the chain.
    expect(updated.displayName).toBe('Renamed');
    expect(updated.entries.map((entry) => entry.model)).toEqual([
      'gpt-4o-mini',
      'claude-3-opus-20240229',
    ]);
  });

  it('refuses to rename a combo', async () => {
    const combo = await createCombo(app, cookie);

    const response = await call(app, pathOf(consolePaths.combo, combo.id), {
      method: 'PATCH',
      body: { name: 'something-else' },
      cookie,
    });

    // The console disables the field, so the API has to refuse rather than
    // silently ignore — otherwise a hand-driven rename looks like it worked.
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('fixed');
  });

  it('accepts a patch that resends the name it already has', async () => {
    const combo = await createCombo(app, cookie);

    const response = await call(app, pathOf(consolePaths.combo, combo.id), {
      method: 'PATCH',
      body: { name: combo.name, displayName: 'Same name, new label' },
      cookie,
    });

    // This is the shape the console actually sends, so it must not be a refusal.
    expect(response.status).toBe(200);
  });

  it('deletes the combo and its entries together', async () => {
    const combo = await createCombo(app, cookie);

    const deleted = await call(app, pathOf(consolePaths.combo, combo.id), {
      method: 'DELETE',
      cookie,
    });
    expect(okSchema.parse(await deleted.json()).ok).toBe(true);

    expect(server.combos.findById(combo.id)).toBeNull();
    // The entries are gone with it, not orphaned: no foreign key is declared, so
    // the repository is the only thing holding that guarantee.
    expect(server.persistence.sqlite.query('select count(*) as n from combo_entries').get()).toEqual({
      n: 0,
    });
  });

  it('answers not_found for an id that does not exist', async () => {
    const response = await call(app, pathOf(consolePaths.combo, 'nope'), { cookie });
    expect(response.status).toBe(404);
  });

  it('refuses a combo with no entries', async () => {
    const response = await call(app, COMBOS_PATH, {
      method: 'POST',
      body: { ...COMBO_INPUT, entries: [] },
      cookie,
    });

    expect(response.status).toBe(400);
  });
});

describe('aliases', () => {
  it('creates one and reads it back', async () => {
    const alias = await createAlias(app, cookie);

    expect(alias.alias).toBe('fast');
    expect(alias.target).toBe('gpt-4o-mini');
    expect(alias.enabled).toBe(true);
  });

  it('repoints the target without touching the name', async () => {
    const alias = await createAlias(app, cookie);

    const response = await call(app, pathOf(consolePaths.alias, alias.id), {
      method: 'PATCH',
      body: { target: 'gpt-4o' },
      cookie,
    });

    const updated = (await response.json()) as Alias;
    expect(updated.alias).toBe('fast');
    expect(updated.target).toBe('gpt-4o');
  });

  it('refuses to rename an alias', async () => {
    const alias = await createAlias(app, cookie);

    const response = await call(app, pathOf(consolePaths.alias, alias.id), {
      method: 'PATCH',
      body: { alias: 'faster' },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('fixed');
  });

  it('refuses a duplicate alias name', async () => {
    await createAlias(app, cookie);

    const response = await call(app, ALIASES_PATH, { method: 'POST', body: ALIAS_INPUT, cookie });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('already exists');
  });

  it('lists what it has', async () => {
    await createAlias(app, cookie);

    const response = await call(app, ALIASES_PATH, { cookie });
    const page = aliasesResponseSchema.parse(await response.json());

    expect(page.items.map((alias) => alias.alias)).toEqual(['fast']);
  });

  it('deletes', async () => {
    const alias = await createAlias(app, cookie);

    const response = await call(app, pathOf(consolePaths.alias, alias.id), {
      method: 'DELETE',
      cookie,
    });

    expect(okSchema.parse(await response.json()).ok).toBe(true);
    expect(server.aliases.findById(alias.id)).toBeNull();
  });
});

describe('model mapping', () => {
  it('creates a rule and reads it back', async () => {
    const mapping = await createMapping(app, cookie);

    expect(mapping.match).toBe('exact');
    expect(mapping.priority).toBe(0);
  });

  it('lists in priority order, lowest first', async () => {
    await createMapping(app, cookie, { ...MAPPING_INPUT, pattern: 'late', priority: 10 });
    await createMapping(app, cookie, { ...MAPPING_INPUT, pattern: 'early', priority: 1 });

    const response = await call(app, MAPPINGS_PATH, { cookie });
    const page = mappingsResponseSchema.parse(await response.json());

    expect(page.items.map((mapping) => mapping.pattern)).toEqual(['early', 'late']);
  });

  it('sorts by priority numerically, not as text', async () => {
    await createMapping(app, cookie, { ...MAPPING_INPUT, pattern: 'two', priority: 2 });
    await createMapping(app, cookie, { ...MAPPING_INPUT, pattern: 'ten', priority: 10 });

    const response = await call(app, `${MAPPINGS_PATH}?sort=priority&direction=asc`, { cookie });
    const page = mappingsResponseSchema.parse(await response.json());

    // As text, "10" sorts before "2" — the one column on this page where an
    // operator has typed a number and would notice.
    expect(page.items.map((mapping) => mapping.pattern)).toEqual(['two', 'ten']);
  });

  it('previews a draft rule against sample ids without saving it', async () => {
    const response = await call(app, PREVIEW_PATH, {
      method: 'POST',
      body: {
        match: 'contains',
        pattern: 'gpt-4o',
        replacement: 'gpt-4o-2024-11-20',
        samples: ['gpt-4o', 'gpt-4o-mini', 'claude-3-opus-20240229'],
      },
      cookie,
    });

    const result = mappingPreviewResultSchema.parse(await response.json());
    expect(result.results).toEqual([
      { input: 'gpt-4o', output: 'gpt-4o-2024-11-20', matched: true },
      { input: 'gpt-4o-mini', output: 'gpt-4o-2024-11-20-mini', matched: true },
      { input: 'claude-3-opus-20240229', output: 'claude-3-opus-20240229', matched: false },
    ]);
    // A preview writes nothing: the mapping list is still empty afterwards.
    const listed = await call(app, MAPPINGS_PATH, { cookie });
    expect(mappingsResponseSchema.parse(await listed.json()).total).toBe(0);
  });

  it('reports an unparsable regex as a non-match rather than an error', async () => {
    const response = await call(app, PREVIEW_PATH, {
      method: 'POST',
      body: { match: 'regex', pattern: 'gpt-(', replacement: 'x', samples: ['gpt-4o'] },
      cookie,
    });

    expect(response.status).toBe(200);
    const result = mappingPreviewResultSchema.parse(await response.json());
    expect(result.results[0]).toEqual({ input: 'gpt-4o', output: 'gpt-4o', matched: false });
  });

  it('refuses a preview with no samples', async () => {
    const response = await call(app, PREVIEW_PATH, {
      method: 'POST',
      body: { match: 'exact', pattern: 'a', replacement: 'b', samples: [] },
      cookie,
    });

    expect(response.status).toBe(400);
  });

  it('deletes', async () => {
    const mapping = await createMapping(app, cookie);

    const response = await call(app, pathOf(consolePaths.mapping, mapping.id), {
      method: 'DELETE',
      cookie,
    });

    expect(okSchema.parse(await response.json()).ok).toBe(true);
  });
});
