import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CONSOLE_API_PREFIX,
  accountsResponseSchema,
  aliasesResponseSchema,
  apiKeysResponseSchema,
  authStatusSchema,
  backupManifestSchema,
  baselinesResponseSchema,
  benchmarksResponseSchema,
  chatSessionsResponseSchema,
  combosResponseSchema,
  consolePaths,
  customizationSchema,
  dashboardSchema,
  consoleMetaSchema,
  filterRulesResponseSchema,
  generalSettingsSchema,
  jobsResponseSchema,
  logsResponseSchema,
  mappingsResponseSchema,
  modelCatalogResponseSchema,
  proxiesResponseSchema,
  proxiesSummarySchema,
  providersResponseSchema,
  quotaOverviewSchema,
  requestsResponseSchema,
  smsProvidersResponseSchema,
  smsProvidersSummarySchema,
  studioAssetsResponseSchema,
  studioGenerationsResponseSchema,
  tokenSaverConfigSchema,
  tokenSaverSavingsSchema,
  usageBreakdownResponseSchema,
  usageSeriesSchema,
  usageSummarySchema,
  vccBinsResponseSchema,
  vccCardsResponseSchema,
  verificationsResponseSchema,
} from '@contracts';

import { buildApp } from '@server/app.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * Every console GET, against the contract that describes it (ROADMAP D1).
 *
 * `packages/contracts` is the only thing the two halves of rutekit share, so it
 * is where "what does this endpoint answer" is written down. The frontend holds
 * the server to it twice over — `apiRequest` validates every response against
 * the schema, and `mock-api.test.ts` proves the mocks answer those same shapes.
 *
 * What neither of those can do is check the **server**. The mocks are the
 * frontend's stand-in for it, so a route that drifted from its schema would keep
 * passing both: the mocks would stay faithful to the contract while the real
 * route quietly answered something else, and the first symptom would be a
 * production console reporting "response did not match its contract" on a page
 * that had been green in every test.
 *
 * So this file drives the real app — through `buildApp`, with a real session and
 * a real database — and validates each answer against the schema the contract
 * declares for that path. It is the server's half of a promise the frontend was
 * already keeping.
 *
 * ## The table, and why it is written out
 *
 * There is no path→schema map in the source to read: a route declares no
 * response schema, and deriving one from the frontend's data layer would mean
 * this test importing `apps/web`, which the boundary forbids. So the table below
 * is transcribed from `apps/web/src/data/*` — the place where the mapping already
 * exists and is already authoritative — and the first test asserts it stays
 * complete, so a route added later cannot be silently uncovered.
 *
 * A route whose answer is not a contract document is listed in `NOT_DOCUMENTS`
 * with the reason. Naming them is the point: "this endpoint is not covered" is a
 * fact a reader should be able to see rather than infer from an absence.
 */

const PASSWORD = 'correct-horse-battery';

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

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

/**
 * The schema each parameterless console GET answers, keyed by its `consolePaths`
 * entry so a renamed path is a type error rather than a silently skipped test.
 *
 * Only GETs with no `:param` are here. A route with a parameter needs a real id
 * to exist first, and building one is what the per-feature route tests already
 * do; what is missing is the breadth, and breadth is what parameterless routes
 * give for free.
 */
const CONSOLE_GET_SCHEMAS: Readonly<Partial<Record<keyof typeof consolePaths, z.ZodType>>> = {
  // Overview
  dashboard: dashboardSchema,
  usageSummary: usageSummarySchema,
  usageSeries: usageSeriesSchema,
  usageBreakdown: usageBreakdownResponseSchema,
  requests: requestsResponseSchema,
  logs: logsResponseSchema,

  // Providers
  providers: providersResponseSchema,
  models: modelCatalogResponseSchema,
  accounts: accountsResponseSchema,
  quota: quotaOverviewSchema,

  // Routing
  combos: combosResponseSchema,
  aliases: aliasesResponseSchema,
  mappings: mappingsResponseSchema,
  filterRules: filterRulesResponseSchema,
  tokenSaver: tokenSaverConfigSchema,
  tokenSaverSavings: tokenSaverSavingsSchema,
  apiKeys: apiKeysResponseSchema,

  // Automation
  jobs: jobsResponseSchema,
  proxies: proxiesResponseSchema,
  proxiesSummary: proxiesSummarySchema,
  smsProviders: smsProvidersResponseSchema,
  smsProvidersSummary: smsProvidersSummarySchema,

  // Tools
  chatSessions: chatSessionsResponseSchema,
  studioAssets: studioAssetsResponseSchema,
  studioGenerations: studioGenerationsResponseSchema,
  benchmarks: benchmarksResponseSchema,
  verifications: verificationsResponseSchema,
  verificationsBaselines: baselinesResponseSchema,
  vccCards: vccCardsResponseSchema,
  vccBins: vccBinsResponseSchema,

  // System
  meta: consoleMetaSchema,
  customization: customizationSchema,
  generalSettings: generalSettingsSchema,
  authStatus: authStatusSchema,
  backupManifest: backupManifestSchema,
};

/**
 * Parameterless console GETs that are deliberately not validated, and why.
 *
 * Each of these answers something that is not a contract document — bytes, a
 * stream, a redirect — so "validate it against a schema" has no meaning for
 * them. Listing them keeps the completeness check honest: the alternative is a
 * `filter` in the test that quietly hides whatever it does not recognise.
 */
const NOT_DOCUMENTS: Readonly<Partial<Record<keyof typeof consolePaths, string>>> = {
  // Answers a rendered Markdown file with a content type the browser acts on,
  // not a JSON document. A parameterless variant does not exist either — it is
  // always `/chat/sessions/:id/export` — so it is here for the record only.
  chatExport: 'a Markdown file, not a document',
  // The OAuth callback is a redirect back into the console.
  providerOauthCallback: 'a redirect, not a document',
};

/** A GET with no `:param`, which is what this file can drive without seeding. */
function isParameterlessGet(name: keyof typeof consolePaths): boolean {
  return !consolePaths[name].includes(':');
}

const ALL_PARAMETERLESS_GETS = (Object.keys(consolePaths) as (keyof typeof consolePaths)[]).filter(
  isParameterlessGet,
);

/**
 * Paths that exist in the contract as a GET but are reached with a method this
 * file does not drive, or that the console writes to rather than reads.
 *
 * They are excluded from the completeness check by *being* in the tables above or
 * here — never by a filter that could grow to hide a gap.
 */
const NOT_READ_AS_GET: Readonly<Partial<Record<keyof typeof consolePaths, string>>> = {
  lowStress: 'POST — flips the routing switch',
  accountsBulk: 'POST — one action across many accounts',
  mappingsPreview: 'POST — a preview of a rule the operator is still editing',
  quotaCheck: 'POST — starts a check-in and answers with the refreshed overview',
  proxiesCheck: 'POST — probes the pool',
  proxiesImport: 'POST — a pasted list',
  smsProvidersCheck: 'POST — checks balances',
  verificationsCalibrate: 'POST — measures a reference from an endpoint',
  vccGenerate: 'POST — mints cards',
  dotTrick: 'POST — generates variants from a body',
  backup: 'POST — answers the archive itself',
  restore: 'POST — replaces the instance',
  authSetup: 'POST — the first run',
  authLogin: 'POST — opens a session',
  authLogout: 'POST — ends one',
  authPassword: 'POST — changes it',
};

describe('the console contract', () => {
  it('names every parameterless GET, in one table or the other', () => {
    // The guard that keeps the tables below from rotting. A route added to
    // `consolePaths` without a schema here would otherwise be uncovered and the
    // suite would stay green — the failure mode this whole file exists to stop.
    const unaccounted = ALL_PARAMETERLESS_GETS.filter(
      (name) =>
        CONSOLE_GET_SCHEMAS[name] === undefined &&
        NOT_DOCUMENTS[name] === undefined &&
        NOT_READ_AS_GET[name] === undefined,
    );

    expect(unaccounted).toEqual([]);
  });

  it('validates a real number of routes', () => {
    // Without this, an enumeration that silently emptied would make every
    // assertion below pass by doing nothing.
    expect(ALL_PARAMETERLESS_GETS.length).toBeGreaterThan(25);
    expect(Object.keys(CONSOLE_GET_SCHEMAS).length).toBeGreaterThan(25);
  });

  it('declares no schema for a path the contract does not have', () => {
    // `keyof typeof consolePaths` already forbids this at compile time; asserting
    // it here as well is what catches a table entry surviving a deleted path.
    const declared = Object.keys(CONSOLE_GET_SCHEMAS);
    const known = new Set(Object.keys(consolePaths));
    expect(declared.filter((name) => !known.has(name))).toEqual([]);
  });

  describe.each(Object.keys(CONSOLE_GET_SCHEMAS) as (keyof typeof consolePaths)[])(
    'GET %s',
    (name) => {
      it('answers a body its contract accepts', async () => {
        const server = makeServer();
        server.lifecycle.markReady();
        servers.push(server);

        const app = buildApp(server);
        const cookie = await signIn(app);
        const schema = CONSOLE_GET_SCHEMAS[name];
        if (schema === undefined) throw new Error(`${name} has no schema`);

        const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths[name]}`, {
          headers: { cookie },
        });

        // A 500 here is a route that threw on an empty instance, which is worth
        // knowing on its own — a fresh install must not have a page that errors.
        expect(response.status, `${name} answered ${String(response.status)}`).toBe(200);

        const parsed = schema.safeParse(await response.json());
        if (!parsed.success) {
          // The issue path is what makes a failure actionable: "expected array,
          // received undefined" at `items.0.status` names the field.
          const detail = parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          throw new Error(`${name} answered a body its schema rejects — ${detail}`);
        }
        expect(parsed.success).toBe(true);
      });
    },
  );
});
