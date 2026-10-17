import { describe, expect, it } from 'vitest';
import type { Usage } from '@contracts';
import type { ManifestModel } from '@registry';

import { entryFromLogLine, createLogRing } from '@server/observability/log-ring.ts';
import { costOf } from '@server/telemetry/cost.ts';
import { REDACTED, redactPayload } from '@server/telemetry/redact.ts';
import { windowRange } from '@server/telemetry/window.ts';

/**
 * Telemetry's pure half (C6, FR-12.2–12.4).
 *
 * Cost, redaction, window arithmetic and the log ring are all functions with no
 * database and no clock of their own, so they are exercised directly. What they
 * have in common is that each one is a place a plausible-looking implementation
 * would be quietly wrong: a cost that prices an unknown model as free, a redactor
 * that misses a key pasted into the wrong field, a bucket grid that does not line
 * up with the one SQL computes, a log parser that swallows a line it did not
 * understand.
 */

function model(overrides: Partial<ManifestModel> = {}): ManifestModel {
  return {
    id: 'test-model',
    displayName: '',
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: { vision: false, tools: false, reasoning: false, embedding: false },
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
    deprecated: false,
    upstreamId: null,
    wireFamily: null,
    requiresCredit: false,
    ...overrides,
  };
}

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

describe('cost', () => {
  it('prices input and output at the manifest rate', () => {
    // 1M in at $3 plus 1M out at $15.
    expect(costOf(model(), usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toBe(18);
  });

  it('prices a small turn proportionally', () => {
    // 1000 in at $3/M is $0.003; 500 out at $15/M is $0.0075.
    expect(costOf(model(), usage({ inputTokens: 1000, outputTokens: 500 }))).toBe(0.0105);
  });

  it('returns null when the model carries no price at all', () => {
    // A locally hosted model and a model rutekit has not learned the price of are
    // both unpriced, and reporting either as $0 would claim it is free.
    expect(
      costOf(model({ inputPricePerMTok: null, outputPricePerMTok: null }), usage({ inputTokens: 500 })),
    ).toBeNull();
  });

  it('treats a one-sided price as the rate it declares', () => {
    // Output-only pricing exists (some providers bill a flat output rate), so the
    // missing half counts as zero rather than making the whole turn unpriced.
    expect(
      costOf(
        model({ inputPricePerMTok: null, outputPricePerMTok: 10 }),
        usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ),
    ).toBe(10);
  });

  it('bills cached input at the full input rate', () => {
    // The manifest has one input price and no cached rate, so cached tokens are
    // counted as input. That overestimates rather than underestimates, which is
    // the direction an operator budgeting from this figure wants to be wrong in.
    expect(costOf(model(), usage({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }))).toBe(3);
  });

  it('rounds to a millionth of a cent, so a sum carries no float noise', () => {
    const cost = costOf(model(), usage({ inputTokens: 1, outputTokens: 1 }));
    expect(cost).toBe(0.000018);
  });
});

describe('redaction', () => {
  it('replaces a value under a secret key, at any depth', () => {
    const { value, redacted } = redactPayload({
      model: 'gpt-4o',
      auth: { apiKey: 'whatever-this-is' },
    });

    expect(redacted).toBe(true);
    expect(value).toEqual({ model: 'gpt-4o', auth: { apiKey: REDACTED } });
  });

  it('matches a secret key whatever its casing or separator', () => {
    const { value } = redactPayload({ API_KEY: 'a', api_key: 'b', ApiKey: 'c', accessToken: 'd' });
    expect(value).toEqual({
      API_KEY: REDACTED,
      api_key: REDACTED,
      ApiKey: REDACTED,
      accessToken: REDACTED,
    });
  });

  it('replaces a credential-shaped value under an innocent key', () => {
    // "Somebody pasted the key into the wrong field" is not a hypothetical, and a
    // redactor that only looked at key names would write it straight to disk.
    const { value, redacted } = redactPayload({
      note: 'use sk-proj-abcdefghijklmnopqrstuvwxyz1234 for that',
    });

    expect(redacted).toBe(true);
    expect(String((value as { note: string }).note)).toContain(REDACTED);
    expect(String((value as { note: string }).note)).not.toContain('sk-proj-');
  });

  it('replaces a bearer token and a JWT wherever they appear', () => {
    const bearer = redactPayload({ text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' });
    expect(String((bearer.value as { text: string }).text)).toContain(REDACTED);

    const jwt = redactPayload({
      text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g',
    });
    expect(String((jwt.value as { text: string }).text)).toContain(REDACTED);
  });

  it('leaves ordinary text alone', () => {
    // The digit requirement on the long-run pattern is what makes this true: a
    // long English word or a path segment must survive, or the inspector redacts
    // the request it was opened to show.
    const input = {
      messages: [
        {
          role: 'user',
          content: 'Please summarise this long document about internationalisation.',
        },
      ],
      path: '/v1/chat/completions',
    };

    const { value, redacted } = redactPayload(input);
    expect(redacted).toBe(false);
    expect(value).toEqual(input);
  });

  it('leaves a long model id alone', () => {
    // Real model ids are long and contain no digits sometimes, but the common ones
    // do; either way they must not be swallowed by the opaque-run pattern.
    const { value } = redactPayload({ model: 'meta-llama/Meta-Llama-3.1-70B-Instruct' });
    expect(value).toEqual({ model: 'meta-llama/Meta-Llama-3.1-70B-Instruct' });
  });

  it('never mutates its input', () => {
    const input = { apiKey: 'secret-value', nested: { token: 'another' } };
    const copy = structuredClone(input);
    redactPayload(input);
    expect(input).toEqual(copy);
  });

  it('reports no redaction when there was nothing to redact', () => {
    expect(redactPayload({ model: 'gpt-4o' }).redacted).toBe(false);
  });

  it('walks arrays', () => {
    const { value } = redactPayload({ keys: [{ apiKey: 'a' }, { apiKey: 'b' }] });
    expect(value).toEqual({ keys: [{ apiKey: REDACTED }, { apiKey: REDACTED }] });
  });
});

describe('window arithmetic', () => {
  const now = new Date('2026-10-13T12:34:56.000Z');

  it('ends just past now, so a row written this instant counts', () => {
    const range = windowRange('1h', now);
    expect(Date.parse(range.to)).toBeGreaterThan(now.getTime());
    expect(Date.parse(range.from)).toBe(now.getTime() - 3_600_000);
  });

  it('starts `all` at the epoch, because retention is what bounds the scan', () => {
    expect(windowRange('all', now).from).toBe(new Date(0).toISOString());
  });

  it('buckets a short window finely and a long one coarsely', () => {
    expect(windowRange('1h', now).bucketSeconds).toBe(60);
    expect(windowRange('30d', now).bucketSeconds).toBe(86_400);
  });
});

describe('the log ring', () => {
  function line(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      level: 30,
      time: '2026-10-13T12:00:00.000Z',
      msg: 'something happened',
      ...overrides,
    });
  }

  it('parses a pino line into a contract entry', () => {
    const entry = entryFromLogLine(line({ requestId: 'req_1' }));

    expect(entry).not.toBeNull();
    expect(entry?.level).toBe('info');
    expect(entry?.message).toBe('something happened');
    expect(entry?.requestId).toBe('req_1');
  });

  it('maps pino levels onto the four the console offers', () => {
    expect(entryFromLogLine(line({ level: 10 }))?.level).toBe('debug');
    expect(entryFromLogLine(line({ level: 40 }))?.level).toBe('warn');
    expect(entryFromLogLine(line({ level: 50 }))?.level).toBe('error');
    // pino's `fatal` has no tab of its own, and it is certainly not `info`.
    expect(entryFromLogLine(line({ level: 60 }))?.level).toBe('error');
  });

  it('derives the kind from the line’s own fields', () => {
    expect(entryFromLogLine(line({ accountId: 'a_1' }))?.kind).toBe('account');
    expect(entryFromLogLine(line({ path: '/v1/chat/completions' }))?.kind).toBe('route');
    expect(entryFromLogLine(line({ model: 'gpt-4o' }))?.kind).toBe('token');
    expect(entryFromLogLine(line())?.kind).toBe('system');
    // An error is an error whatever it is about.
    expect(entryFromLogLine(line({ level: 50, accountId: 'a_1' }))?.kind).toBe('error');
  });

  it('returns null for a line it cannot read rather than guessing', () => {
    // A stray `console.log` or a dependency's own output is not rutekit's log.
    expect(entryFromLogLine('not json at all')).toBeNull();
    expect(entryFromLogLine(JSON.stringify({ hello: 'world' }))).toBeNull();
  });

  it('keeps the newest entries and drops the oldest', () => {
    const ring = createLogRing(3);
    for (let index = 0; index < 5; index += 1) {
      ring.append(entryFromLogLine(line({ msg: `line ${String(index)}` }))!);
    }

    const page = ring.list({ level: null, kind: null, requestId: null, q: '', sort: null, direction: 'desc', limit: 50, cursor: null });
    expect(page.total).toBe(3);
    // Newest first by default: a tail is read from the bottom.
    expect(page.items.map((entry) => entry.message)).toEqual(['line 4', 'line 3', 'line 2']);
  });

  it('counts levels over the filtered set, so the tabs add up', () => {
    const ring = createLogRing(10);
    ring.append(entryFromLogLine(line({ level: 30 }))!);
    ring.append(entryFromLogLine(line({ level: 40 }))!);
    ring.append(entryFromLogLine(line({ level: 50 }))!);

    const page = ring.list({ level: null, kind: null, requestId: null, q: '', sort: null, direction: 'desc', limit: 50, cursor: null });
    expect(page.counts).toEqual({ debug: 0, info: 1, warn: 1, error: 1 });
  });

  it('filters by level, kind, request and free text', () => {
    const ring = createLogRing(10);
    ring.append(entryFromLogLine(line({ level: 40, accountId: 'a_1', msg: 'account parked' }))!);
    ring.append(entryFromLogLine(line({ level: 30, requestId: 'req_1', msg: 'turn served' }))!);

    const base = { sort: null, direction: 'desc', limit: 50, cursor: null } as const;
    expect(ring.list({ ...base, level: 'warn', kind: null, requestId: null, q: '' }).total).toBe(1);
    expect(ring.list({ ...base, level: null, kind: 'account', requestId: null, q: '' }).total).toBe(1);
    expect(ring.list({ ...base, level: null, kind: null, requestId: 'req_1', q: '' }).total).toBe(1);
    expect(ring.list({ ...base, level: null, kind: null, requestId: null, q: 'parked' }).total).toBe(1);
  });

  it('tells its subscribers about an append', () => {
    const ring = createLogRing(10);
    const seen: string[] = [];
    const stop = ring.subscribe((entry) => seen.push(entry.message));

    ring.append(entryFromLogLine(line({ msg: 'first' }))!);
    stop();
    ring.append(entryFromLogLine(line({ msg: 'second' }))!);

    expect(seen).toEqual(['first']);
  });
});
