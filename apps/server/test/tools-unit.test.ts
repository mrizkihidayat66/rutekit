import { describe, expect, it } from 'vitest';

import { chooseBin, vccBins } from '@server/tools/bins.ts';
import { expandEmail, MAX_VARIANTS } from '@server/tools/dot-trick.ts';
import { applyPhase, matches, redact, REDACTION, type FilterRuleLike } from '@server/tools/filters.ts';
import { checkDigit, completeNumber, groupedNumber, maskedNumber, passesLuhn } from '@server/tools/luhn.ts';
import { ingestRequest } from '@translator';

/**
 * The tools' pure half (C8, FR-11.1–11.3).
 *
 * Luhn arithmetic, dot expansion, the BIN catalogue and the filter engine are all
 * functions with no clock, no database and no I/O, so they are exercised
 * directly. Each one is a place a plausible-looking implementation would be
 * quietly wrong: a check digit computed from the wrong parity, a dot mask that
 * misses the endpoints, a filter that scans a tool's JSON Schema.
 */

describe('the Luhn checksum', () => {
  it('accepts the numbers the card networks publish as valid', () => {
    // The publicly documented test numbers, which is the one set that can be
    // asserted without a card.
    for (const pan of ['4111111111111111', '5555555555554444', '378282246310005']) {
      expect(passesLuhn(pan), pan).toBe(true);
    }
  });

  it('rejects a number whose last digit is wrong', () => {
    expect(passesLuhn('4111111111111112')).toBe(false);
  });

  it('rejects anything that is not digits', () => {
    expect(passesLuhn('4111 1111 1111 1111')).toBe(false);
    expect(passesLuhn('')).toBe(false);
  });

  it('computes the digit that makes a body valid', () => {
    // 411111111111111 has 15 digits; appending 1 makes the published number.
    expect(checkDigit('411111111111111')).toBe(1);
  });

  it('completes a number that passes its own check', () => {
    for (const bin of ['411111', '555555', '378282', '601111']) {
      const pan = completeNumber(bin, [1, 2, 3, 4, 5, 6, 7, 8, 9], 16);
      expect(pan.startsWith(bin), bin).toBe(true);
      expect(pan).toHaveLength(16);
      expect(passesLuhn(pan), pan).toBe(true);
    }
  });

  it('pads a short body rather than producing a short number', () => {
    // Fewer random digits than the range has room for: the number still has to be
    // the right length, so the gap fills rather than the length shrinking.
    const pan = completeNumber('411111', [1, 2], 16);
    expect(pan).toHaveLength(16);
    expect(passesLuhn(pan)).toBe(true);
  });

  it('refuses a BIN that cannot fit the length asked for', () => {
    expect(() => completeNumber('411111', [], 5)).toThrow(/cannot fit/u);
  });
});

describe('the display forms', () => {
  it('groups sixteen digits in fours', () => {
    // The bullets are grouped with the digits, so the display string has the shape
    // of a card number rather than a BIN with a gap after it.
    expect(maskedNumber('411111', '1234', 16)).toBe('4111 11•• •••• 1234');
  });

  it('groups a fifteen-digit number in the 4-6-5 amex split', () => {
    // A 15-digit number shown in fours reads as a different card.
    expect(maskedNumber('378282', '0005', 15)).toBe('3782 82•••• •0005');
  });

  it('groups a full number the way a form field expects it', () => {
    expect(groupedNumber('4111111111111111')).toBe('4111 1111 1111 1111');
    expect(groupedNumber('378282246310005')).toBe('3782 822463 10005');
  });

  it('leaves an unusual length ungrouped rather than truncating it', () => {
    // Every digit matters; a grouping that does not cover the length must not
    // silently drop one.
    const odd = '1234567890123456789';
    expect(groupedNumber(odd)).toBe(odd);
  });
});

describe('the BIN catalogue', () => {
  it('gives every range a brand, a length and an acceptance figure', () => {
    for (const bin of vccBins()) {
      expect(bin.bin, bin.bin).toMatch(/^\d{6,8}$/u);
      expect(bin.length, bin.bin).toBeGreaterThanOrEqual(bin.bin.length + 1);
      expect(bin.acceptance, bin.bin).toBeGreaterThanOrEqual(0);
      expect(bin.acceptance, bin.bin).toBeLessThanOrEqual(1);
    }
  });

  it('has at least one range for every brand the contract names', () => {
    for (const brand of ['visa', 'mastercard', 'amex', 'discover'] as const) {
      expect(vccBins().some((bin) => bin.brand === brand), brand).toBe(true);
    }
  });

  it('picks the best-accepted range when none was named', () => {
    const chosen = chooseBin('visa', null);
    const best = vccBins()
      .filter((bin) => bin.brand === 'visa')
      .reduce((top, bin) => (bin.acceptance > top.acceptance ? bin : top));

    expect(chosen?.bin).toBe(best.bin);
  });

  it('refuses a range that does not belong to the brand asked for', () => {
    // A batch claiming a Visa brand under an Amex range is a contradiction, and
    // the caller is the one that turns this null into a refusal.
    expect(chooseBin('visa', '378282')).toBeNull();
  });
});

describe('the dot trick', () => {
  it('expands a two-character local part into one dotted spelling', () => {
    // One gap, so the mask has exactly one bit: `a.b` and nothing else. The bare
    // `ab` is not a variant — it is the address the operator already has.
    const result = expandEmail('ab@example.com', { mode: 'dot', limit: 0 });

    expect(result.variants.map((entry) => entry.address)).toEqual(['a.b@example.com']);
    expect(result.localPart).toBe('ab');
    expect(result.domain).toBe('example.com');
  });

  it('spells every dot combination for a three-character local part', () => {
    const result = expandEmail('abc@example.com', { mode: 'dot', limit: 0 });
    const addresses = result.variants.map((entry) => entry.address).sort();

    // Two gaps, so three spellings: a.bc, ab.c, a.b.c.
    expect(addresses).toEqual(['a.b.c@example.com', 'a.bc@example.com', 'ab.c@example.com']);
  });

  it('generates the fixed plus tags', () => {
    const result = expandEmail('alice@example.com', { mode: 'plus', limit: 0 });

    expect(result.variants.map((entry) => entry.address)).toEqual([
      'alice+rc@example.com',
      'alice+alt@example.com',
      'alice+probe@example.com',
      'alice+x1@example.com',
      'alice+s2@example.com',
    ]);
    expect(result.variants.every((entry) => entry.technique === 'plus')).toBe(true);
  });

  it('alternates the two techniques so a capped list carries both', () => {
    // Asking for "both" and being handed a page of dots is not an answer to the
    // question that was asked.
    const result = expandEmail('abcdef@example.com', { mode: 'both', limit: 6 });
    const techniques = result.variants.map((entry) => entry.technique);

    expect(techniques.slice(0, 6)).toEqual(['dot', 'plus', 'dot', 'plus', 'dot', 'plus']);
    expect(result.truncated).toBe(true);
  });

  it('says when the cap cut the list short', () => {
    // Ten characters is nine gaps, so 511 dot spellings — well past a cap of ten.
    const capped = expandEmail('abcdefghij@example.com', { mode: 'dot', limit: 10 });
    expect(capped.variants).toHaveLength(10);
    expect(capped.truncated).toBe(true);

    const whole = expandEmail('ab@example.com', { mode: 'dot', limit: 0 });
    expect(whole.truncated).toBe(false);
  });

  it('truncates at the contract ceiling, where the power set outgrows it', () => {
    // Eleven characters is ten gaps, so 1023 spellings — the first length where
    // the mode can spell more than the 512 the contract allows.
    const result = expandEmail('abcdefghijk@example.com', { mode: 'dot', limit: 0 });
    expect(result.variants).toHaveLength(MAX_VARIANTS);
    expect(result.truncated).toBe(true);
  });

  it('reports no truncation when the mode can spell less than the cap', () => {
    // Ten characters is nine gaps, so 511 spellings — one under the ceiling, so
    // nothing was cut and saying otherwise would be a lie about the list.
    const result = expandEmail('abcdefghij@example.com', { mode: 'dot', limit: 0 });
    expect(result.variants).toHaveLength(511);
    expect(result.truncated).toBe(false);
  });

  it('honours the contract ceiling even when the caller asks for more', () => {
    const result = expandEmail('abcdefghijklmnop@example.com', { mode: 'dot', limit: 100_000 });
    expect(result.variants.length).toBeLessThanOrEqual(MAX_VARIANTS);
  });

  it('produces no dots for a single-character local part', () => {
    // No gaps to put one in, so the mode is honestly empty rather than inventing
    // a spelling that is not a variant of anything.
    const result = expandEmail('a@example.com', { mode: 'dot', limit: 0 });
    expect(result.variants).toEqual([]);
  });

  it('keeps the domain untouched', () => {
    const result = expandEmail('alice@mail.example.co.uk', { mode: 'both', limit: 0 });
    expect(result.domain).toBe('mail.example.co.uk');
    expect(result.variants.every((entry) => entry.address.endsWith('@mail.example.co.uk'))).toBe(true);
  });
});

const rule = (over: Partial<FilterRuleLike> = {}): FilterRuleLike => ({
  id: 'r1',
  name: 'test rule',
  kind: 'exact',
  pattern: 'secret',
  action: 'block',
  phase: 1,
  enabled: true,
  ...over,
});

function request(body: unknown) {
  return ingestRequest('chat-completions', body);
}

describe('the filter engine', () => {
  it('matches an exact substring', () => {
    expect(matches(rule(), 'this contains secret text')).toBe(true);
    expect(matches(rule(), 'nothing here')).toBe(false);
  });

  it('matches a regex', () => {
    const pattern = rule({ kind: 'regex', pattern: '\\bsk-[A-Za-z0-9]{8,}\\b' });
    expect(matches(pattern, 'key sk-abcdefghij')).toBe(true);
    expect(matches(pattern, 'key nope')).toBe(false);
  });

  it('treats an unparsable regex as a non-match rather than a failure', () => {
    // A typo in one rule must not take down every turn that passes through it.
    expect(matches(rule({ kind: 'regex', pattern: 'a(' }), 'anything')).toBe(false);
    expect(redact(rule({ kind: 'regex', pattern: 'a(' }), 'anything')).toBe('anything');
  });

  it('replaces every match when redacting', () => {
    expect(redact(rule(), 'secret and secret')).toBe(`${REDACTION} and ${REDACTION}`);
  });

  it('blocks a request whose message text matches', () => {
    const outcome = applyPhase(
      request({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a secret plan' }] }),
      [rule()],
      1,
    );

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    // The name is what the refusal quotes, so the operator can find the rule.
    expect(outcome.rule.name).toBe('test rule');
  });

  it('blocks on the system prompt, which is content too', () => {
    const outcome = applyPhase(
      request({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'the secret is 42' },
          { role: 'user', content: 'hello' },
        ],
      }),
      [rule()],
      1,
    );

    expect(outcome.kind).toBe('blocked');
  });

  it('redacts the text and leaves everything else alone', () => {
    const outcome = applyPhase(
      request({ model: 'gpt-4o', messages: [{ role: 'user', content: 'say secret now' }] }),
      [rule({ action: 'redact' })],
      1,
    );

    expect(outcome.kind).toBe('allowed');
    if (outcome.kind !== 'allowed') return;
    expect(outcome.redactions).toBe(1);
    expect(outcome.request.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: `say ${REDACTION} now`,
    });
    // The model id is untouched: this rewrites conversation, not the request.
    expect(outcome.request.model).toBe('gpt-4o');
  });

  it('does not scan a tool definition, which is JSON Schema and not prose', () => {
    // A regex that matched inside `parameters` would produce a schema the provider
    // rejects with a 400 — a failure a long way from its cause.
    const outcome = applyPhase(
      request({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'look up a secret',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
          },
        ],
      }),
      [rule()],
      1,
    );

    expect(outcome.kind).toBe('allowed');
  });

  it('scans the text inside a tool result', () => {
    const outcome = applyPhase(
      request({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'look it up' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
            ],
          },
          { role: 'tool', content: 'the secret is 42', tool_call_id: 'c1' },
        ],
      }),
      [rule({ action: 'redact' })],
      1,
    );

    expect(outcome.kind).toBe('allowed');
    if (outcome.kind !== 'allowed') return;
    expect(outcome.redactions).toBe(1);
    expect(JSON.stringify(outcome.request.messages)).toContain(REDACTION);
  });

  it('runs only the rules for the phase it was asked about', () => {
    const phaseTwo = rule({ phase: 2, name: 'phase two' });
    const body = request({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a secret' }] });

    expect(applyPhase(body, [phaseTwo], 1).kind).toBe('allowed');
    expect(applyPhase(body, [phaseTwo], 2).kind).toBe('blocked');
  });

  it('skips a disabled rule', () => {
    const outcome = applyPhase(
      request({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a secret' }] }),
      [rule({ enabled: false })],
      1,
    );
    expect(outcome.kind).toBe('allowed');
  });

  it('lets a block rule win over a redact rule in the same phase', () => {
    // A request that is going to be refused should not be rewritten first.
    const outcome = applyPhase(
      request({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a secret' }] }),
      [rule({ action: 'redact', name: 'scrub' }), rule({ name: 'stop' })],
      1,
    );

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.rule.name).toBe('stop');
  });

  it('returns the request untouched when there are no rules for the phase', () => {
    const body = request({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] });
    const outcome = applyPhase(body, [], 1);

    expect(outcome.kind).toBe('allowed');
    if (outcome.kind !== 'allowed') return;
    // The same object, not a copy: with nothing to do there is nothing to rebuild.
    expect(outcome.request).toBe(body);
  });
});
