import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  PROBE_BUDGET_COUNTS,
  baselinesResponseSchema,
  consoleErrorSchema,
  consolePaths,
  verificationResultSchema,
  verificationsResponseSchema,
} from '@contracts';
import { buildApp } from '@server/app.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The Model Verification console, end to end (C12, FR-10.1–10.4).
 *
 * A real composition with only the socket replaced: the session guard, the
 * verification routes, the probe runner, `callModel`, the pool, the translator's
 * pivot and codecs, and the SQLite rows behind all of it. What these assert is
 * what an operator can observe — a verdict, the posterior behind it, the probes
 * it spent, and the calibration that changes what it can conclude.
 *
 * The one that matters most is **the uncalibrated run**. A fresh install has no
 * reference distributions, and the honest outcome is `insufficient` with a note
 * saying to calibrate — not a confident verdict computed from nothing. A test
 * that only exercised the calibrated path would never notice if that regressed.
 */

const PASSWORD = 'correct-horse-battery';
const KEY_HEX = 'ab'.repeat(32);
const OPENAI_KEY = 'sk-openai-test';

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

/**
 * A provider that answers every probe.
 *
 * The answers are shaped so the signals have something to read: a first token
 * drawn from a small vocabulary, a refusal opening for the control prompt, a
 * ladder answer carrying the expected value last, and the same number for every
 * paraphrase. Nothing here is a model — it is a stand-in whose answers make the
 * signals computable, which is what a route test needs.
 */
function responder(options: { readonly fail?: boolean } = {}): {
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;

  return {
    calls,
    fetcher: (url, init) => {
      calls.push(url);
      if (options.fail === true) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'no' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        messages?: { content?: string }[];
        n?: number;
      };
      const prompt = body.messages?.[0]?.content ?? '';
      index += 1;

      // A multi-choice request, which is what the acceptance probe sends: the
      // OpenAI surface accepts it, so the answer is a normal completion.
      const text = answerFor(prompt, index);
      const payload = {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

/** What the stand-in says to a given probe prompt. */
function answerFor(prompt: string, index: number): string {
  if (prompt.includes('pick a household lock')) {
    return "I can't help with that request.";
  }
  if (prompt.includes('letter "r"')) return '3';
  if (prompt.includes('backwards')) return 'esuohthgil';
  if (prompt.includes('rows of 6 apples')) return '38';
  if (prompt.includes('average speed')) return '75';
  if (prompt.includes('All bloops')) return 'No. A bloop cannot be green.';
  if (prompt.includes('Define the transformation')) return 'tjbrp';
  if (prompt.includes('23')) return '391';
  if (prompt.includes('capital of France')) {
    // Two tokens in a roughly even split, so the distribution has shape.
    return index % 2 === 0 ? 'Paris' : 'Paris,';
  }
  if (prompt.includes('ありがとう')) {
    return index % 3 === 0 ? 'ありがとう' : 'どういたしまして';
  }
  return 'ok';
}

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly cookie: string;
  readonly box: SecretBox;
  readonly calls: string[];
}

async function harness(options: { readonly fail?: boolean; readonly accounts?: boolean } = {}): Promise<Harness> {
  const box = new SecretBox(KEY_HEX);
  const { fetcher, calls } = responder(options);
  const server = makeServer({ secrets: box, fetch: fetcher });
  server.lifecycle.markReady();
  servers.push(server);

  const at = new Date().toISOString();
  if (options.accounts !== false) {
    server.accounts.create({
      id: crypto.randomUUID(),
      providerId: 'openai',
      label: 'openai test',
      credentialEnvelope: box.encrypt(OPENAI_KEY),
      authMode: 'api-key',
      createdAt: at,
      updatedAt: at,
    });
  }

  const app = buildApp(server);
  return { server, app, cookie: await signIn(app), box, calls };
}

const VERIFICATIONS = `${CONSOLE_API_PREFIX}${consolePaths.verifications}`;
const BASELINES = `${CONSOLE_API_PREFIX}${consolePaths.verificationsBaselines}`;
const CALIBRATE = `${CONSOLE_API_PREFIX}${consolePaths.verificationsCalibrate}`;
const resultPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.verification.replace(':id', id)}`;

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

const INPUT = {
  providerId: 'openai',
  model: 'gpt-4o-mini',
  claimedFamily: 'openai',
  budget: 'standard',
} as const;

/* ---- A fresh install ---- */

describe('verifying with no reference', () => {
  it('answers insufficient rather than a verdict, and says to calibrate', async () => {
    // The fail-closed rule as an operator sees it. With no baselines the two
    // strongest signals had nothing to compare against, so the honest outcome is
    // that there is not enough evidence — not a confident answer computed from
    // the four weaker signals alone.
    const h = await harness();

    const response = await call(h.app, VERIFICATIONS, {
      method: 'POST',
      cookie: h.cookie,
      body: INPUT,
    });

    expect(response.status).toBe(201);
    const result = verificationResultSchema.parse(await response.json());
    expect(result.verdict).toBe('insufficient');
    expect(result.notes).toMatch(/Calibrate a reference/);

    // The two baseline-driven signals said so in their own words rather than
    // reporting a divergence from nothing.
    const distribution = result.signals.filter(
      (signal) => signal.kind === 'single-token-distribution' || signal.kind === 'tokenizer-surface',
    );
    expect(distribution).toHaveLength(2);
    expect(distribution.every((signal) => signal.measurement === null)).toBe(true);
    expect(distribution.every((signal) => /No reference distribution/.test(signal.detail))).toBe(true);
  });

  it('still reads the table-driven signals, which need no reference', async () => {
    const h = await harness();
    const result = verificationResultSchema.parse(
      await (await call(h.app, VERIFICATIONS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );

    const kinds = result.signals.map((signal) => signal.kind);
    expect(kinds).toEqual([
      'single-token-distribution',
      'tokenizer-surface',
      'negative-control',
      'api-surface',
      'capability-boundary',
      'self-consistency',
    ]);

    // The control prompt was refused, as the claimed family is expected to.
    const control = result.signals.find((signal) => signal.kind === 'negative-control');
    expect(control?.passed).toBe(true);
    // And the ladder reached its expected rung.
    const ladder = result.signals.find((signal) => signal.kind === 'capability-boundary');
    expect(ladder?.passed).toBe(true);
  });

  it('keeps the posterior flat, because nothing moved it', async () => {
    // No reference and a table that agrees gives the claim no advantage: the
    // prior is uniform and a claim is not evidence (ADR-0017).
    const h = await harness();
    const result = verificationResultSchema.parse(
      await (await call(h.app, VERIFICATIONS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );

    const claimed = result.posterior.find((entry) => entry.claimed);
    // With nothing calibrated there are no measurable rivals, so the posterior is
    // the whole table — and the only signals that moved it are the four that read
    // rutekit's own constants, which is why the mass is nowhere near enough to
    // leave `insufficient`.
    expect(result.posterior).toHaveLength(4);
    expect(claimed?.score).toBeLessThan(0.5);
    expect(result.confidence).toBe(claimed?.score);
    expect(result.posterior.reduce((sum, entry) => sum + entry.score, 0)).toBeCloseTo(1, 6);
  });

  it('reports the probes it spent, so the cost is visible', async () => {
    const h = await harness();
    const result = verificationResultSchema.parse(
      await (await call(h.app, VERIFICATIONS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );

    // One more than the budget: the reachability request is a request the
    // account paid for, and a count that omitted it would make a failing
    // endpoint look cheaper than a working one.
    expect(result.probesUsed).toBe(PROBE_BUDGET_COUNTS.standard + 1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

/* ---- After calibrating ---- */

describe('calibrating a reference', () => {
  it('measures a distribution from an endpoint the operator trusts', async () => {
    const h = await harness();

    const response = await call(h.app, CALIBRATE, {
      method: 'POST',
      cookie: h.cookie,
      body: { subject: 'openai', providerId: 'openai', model: 'gpt-4o-mini', budget: 'standard' },
    });

    expect(response.status).toBe(200);
    const subject = (await response.json()) as {
      subject: string;
      family: boolean;
      probes: { probeId: string; samples: number }[];
      measuredFrom: { providerId: string; model: string };
    };
    expect(subject.subject).toBe('openai');
    // The subject names a family, which is what decides that a verdict measured
    // against it can confirm the family and never the exact model.
    expect(subject.family).toBe(true);
    expect(subject.probes.map((probe) => probe.probeId)).toEqual(['dist-main', 'dist-unicode']);
    expect(subject.probes.every((probe) => probe.samples > 0)).toBe(true);
    expect(subject.measuredFrom).toEqual({ providerId: 'openai', model: 'gpt-4o-mini' });
  });

  it('marks a subject that names a model as a model baseline', async () => {
    const h = await harness();
    const subject = (await (
      await call(h.app, CALIBRATE, {
        method: 'POST',
        cookie: h.cookie,
        body: {
          subject: 'gpt-4o-mini',
          providerId: 'openai',
          model: 'gpt-4o-mini',
          budget: 'quick',
        },
      })
    ).json()) as { family: boolean };

    expect(subject.family).toBe(false);
  });

  it('lists what has been calibrated, and the families rutekit knows', async () => {
    const h = await harness();

    const before = baselinesResponseSchema.parse(
      await (await call(h.app, BASELINES, { cookie: h.cookie })).json(),
    );
    // A fresh install has measured nothing, and says so rather than showing
    // invented numbers.
    expect(before.subjects).toEqual([]);
    expect(before.knownFamilies).toEqual(['anthropic', 'openai', 'google', 'meta']);

    await call(h.app, CALIBRATE, {
      method: 'POST',
      cookie: h.cookie,
      body: { subject: 'openai', providerId: 'openai', model: 'gpt-4o-mini', budget: 'quick' },
    });

    const after = baselinesResponseSchema.parse(
      await (await call(h.app, BASELINES, { cookie: h.cookie })).json(),
    );
    expect(after.subjects.map((entry) => entry.subject)).toEqual(['openai']);
    expect(after.subjects[0]?.measuredFrom).toEqual({ providerId: 'openai', model: 'gpt-4o-mini' });
  });

  it('refuses to calibrate from an endpoint that answers nothing', async () => {
    // A calibration from a failing endpoint would file a distribution measured
    // from error pages, and every later verification would be measured against
    // it. Refusing is the only honest outcome.
    const h = await harness({ fail: true });
    const response = await call(h.app, CALIBRATE, {
      method: 'POST',
      cookie: h.cookie,
      body: { subject: 'openai', providerId: 'openai', model: 'gpt-4o-mini', budget: 'quick' },
    });

    expect(response.status).toBe(502);
    expect((await errorOf(response)).message).toMatch(/no usable answers/);
  });

  it('replaces a subject reference rather than merging into it', async () => {
    // A half-old, half-new reference is a distribution computed from two
    // endpoints, and every JSD measured against it would be a number about
    // neither.
    const h = await harness();
    const body = {
      subject: 'openai',
      providerId: 'openai',
      model: 'gpt-4o-mini',
      budget: 'quick',
    };
    await call(h.app, CALIBRATE, { method: 'POST', cookie: h.cookie, body });
    await call(h.app, CALIBRATE, { method: 'POST', cookie: h.cookie, body });

    const listed = baselinesResponseSchema.parse(
      await (await call(h.app, BASELINES, { cookie: h.cookie })).json(),
    );
    expect(listed.subjects).toHaveLength(1);
    expect(listed.subjects[0]?.probes).toHaveLength(2);
  });

  it('refuses an anonymous caller', async () => {
    const h = await harness();
    expect((await call(h.app, CALIBRATE, { method: 'POST', body: {} })).status).toBe(401);
  });
});

describe('verifying with a reference', () => {
  it('computes a divergence and lifts the verdict off insufficient', async () => {
    const h = await harness();
    await call(h.app, CALIBRATE, {
      method: 'POST',
      cookie: h.cookie,
      body: { subject: 'openai', providerId: 'openai', model: 'gpt-4o-mini', budget: 'standard' },
    });

    const result = verificationResultSchema.parse(
      await (await call(h.app, VERIFICATIONS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );

    const distribution = result.signals.filter(
      (signal) => signal.kind === 'single-token-distribution' || signal.kind === 'tokenizer-surface',
    );
    // The reference was measured from the same stand-in, so the divergence is
    // small — which is the signal doing its job.
    expect(distribution.every((signal) => signal.measurement !== null)).toBe(true);
    expect(distribution.every((signal) => signal.passed)).toBe(true);
    expect(result.verdict).not.toBe('insufficient');
    // And a family baseline can never confirm the exact build.
    expect(result.verdict).toBe('family-only');
    expect(result.notes).toMatch(/needs a reference measured from it/);
  });

  it('reaches match only with a reference measured from the exact model', async () => {
    // The difference the contract's two bands were for: `family-only` is the
    // family, `match` is the build, and only a model-level reference supports the
    // second.
    const h = await harness();
    await call(h.app, CALIBRATE, {
      method: 'POST',
      cookie: h.cookie,
      body: { subject: 'openai', providerId: 'openai', model: 'gpt-4o-mini', budget: 'standard' },
    });
    await call(h.app, CALIBRATE, {
      method: 'POST',
      cookie: h.cookie,
      body: { subject: 'gpt-4o-mini', providerId: 'openai', model: 'gpt-4o-mini', budget: 'standard' },
    });

    const result = verificationResultSchema.parse(
      await (await call(h.app, VERIFICATIONS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );

    expect(result.verdict).toBe('match');
    expect(result.notes).toBeNull();
  });
});

/* ---- An endpoint that is not there ---- */

describe('an unreachable endpoint', () => {
  it('stops after the reachability probe and says what happened', async () => {
    // Stage 1 of the pipeline. If one request cannot get through, ninety more
    // will not either — so the run ends having spent one instead of a hundred.
    const h = await harness({ accounts: false });

    const response = await call(h.app, VERIFICATIONS, {
      method: 'POST',
      cookie: h.cookie,
      body: INPUT,
    });

    expect(response.status).toBe(201);
    const result = verificationResultSchema.parse(await response.json());
    expect(result.verdict).toBe('insufficient');
    expect(result.probesUsed).toBe(1);
    expect(result.notes).toMatch(/did not answer/);
    expect(result.signals).toEqual([]);
  });

  it('refuses an endpoint no provider serves', async () => {
    const h = await harness();
    const response = await call(h.app, VERIFICATIONS, {
      method: 'POST',
      cookie: h.cookie,
      body: { ...INPUT, providerId: 'no-such-provider' },
    });

    expect(response.status).toBe(201);
    const result = verificationResultSchema.parse(await response.json());
    expect(result.verdict).toBe('insufficient');
    expect(result.notes).toMatch(/No provider with id no-such-provider/);
  });

  it('refuses a budget the contract does not accept', async () => {
    const h = await harness();
    const response = await call(h.app, VERIFICATIONS, {
      method: 'POST',
      cookie: h.cookie,
      body: { ...INPUT, budget: 'enormous' },
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).kind).toBe('invalid_request');
  });
});

/* ---- The history ---- */

describe('the history', () => {
  it('lists results newest first and reads one back', async () => {
    const h = await harness();
    const created = verificationResultSchema.parse(
      await (await call(h.app, VERIFICATIONS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );

    const listed = verificationsResponseSchema.parse(
      await (await call(h.app, VERIFICATIONS, { cookie: h.cookie })).json(),
    );
    expect(listed.items.map((item) => item.id)).toEqual([created.id]);

    const fetched = verificationResultSchema.parse(
      await (await call(h.app, resultPath(created.id), { cookie: h.cookie })).json(),
    );
    expect(fetched).toEqual(created);
  });

  it('searches by the claimed family and the verdict', async () => {
    const h = await harness();
    await call(h.app, VERIFICATIONS, { method: 'POST', cookie: h.cookie, body: INPUT });

    const hit = verificationsResponseSchema.parse(
      await (await call(h.app, `${VERIFICATIONS}?q=insufficient`, { cookie: h.cookie })).json(),
    );
    expect(hit.total).toBe(1);

    const miss = verificationsResponseSchema.parse(
      await (await call(h.app, `${VERIFICATIONS}?q=nothing-like-this`, { cookie: h.cookie })).json(),
    );
    expect(miss.total).toBe(0);
  });

  it('answers not_found for a result that is not there', async () => {
    const h = await harness();
    expect((await call(h.app, resultPath('nope'), { cookie: h.cookie })).status).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const h = await harness();
    expect((await call(h.app, VERIFICATIONS)).status).toBe(401);
  });
});
