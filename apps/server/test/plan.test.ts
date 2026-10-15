import { afterEach, describe, expect, it } from 'vitest';

import { applyRule, rewriteModel, type MappingRule } from '@server/plan/mapping.ts';
import { orderChain, parseStrategy } from '@server/plan/order.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The plan (C5b, FR-1.3–1.5): what a client's model name means.
 *
 * Three pieces, and they are tested at the level each one actually decides at.
 * The mapping engine and the ordering are pure functions with no database and no
 * clock, so they are exercised directly with the exact inputs the planner feeds
 * them. The resolver is not pure — it reads three tables — so it runs over the
 * real composition, which is the only way to assert that an alias, a combo and a
 * mapping compose the way the pipeline diagram says they do.
 */

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

function server(options: { random?: (bytes: number) => Uint8Array } = {}): TestServer {
  const made = makeServer(options.random === undefined ? {} : { random: options.random });
  servers.push(made);
  return made;
}

/**
 * A random source that always yields `fraction` of the unit interval.
 *
 * `pickWeighted` reads four bytes big-endian and divides by 2^32, so this encodes
 * the fraction it is given. It makes a weighted choice assertable instead of
 * statistical: "with the pointer at 0.9, the 3-weight entry wins" is a fact, not
 * a distribution.
 */
function at(fraction: number): (bytes: number) => Uint8Array {
  return () => {
    const value = Math.floor(fraction * 0x1_0000_0000) >>> 0;
    return new Uint8Array([
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ]);
  };
}

const rule = (
  match: MappingRule['match'],
  pattern: string,
  replacement: string,
  id = 'rule-1',
): MappingRule => ({ id, match, pattern, replacement });

describe('the mapping engine', () => {
  it('rewrites an exact match and nothing else', () => {
    expect(applyRule(rule('exact', 'gpt-4o', 'gpt-4o-2024-11-20'), 'gpt-4o')).toBe(
      'gpt-4o-2024-11-20',
    );
    // `exact` means exact: a prefix is a different id.
    expect(applyRule(rule('exact', 'gpt-4o', 'x'), 'gpt-4o-mini')).toBeNull();
  });

  it('rewrites the matched part of a contains rule, leaving the rest', () => {
    expect(applyRule(rule('contains', 'gpt-4o', 'gpt-4o-2024-11-20'), 'gpt-4o-mini')).toBe(
      'gpt-4o-2024-11-20-mini',
    );
    expect(applyRule(rule('contains', 'zzz', 'x'), 'gpt-4o')).toBeNull();
  });

  it('rewrites through a regex, with capture groups', () => {
    expect(applyRule(rule('regex', '^gpt-(.+)$', 'openai/$1'), 'gpt-4o')).toBe('openai/4o');
    expect(applyRule(rule('regex', '^claude-', 'anthropic/'), 'gpt-4o')).toBeNull();
  });

  it('treats an unparsable regex as a non-match rather than a failure', () => {
    // A typo in one rule must not take down every request that passes through the
    // router (R5.5's fail-open reading, applied to the plan).
    expect(applyRule(rule('regex', 'gpt-(', 'x'), 'gpt-4o')).toBeNull();
  });

  it('runs the first matching rule only, and stops', () => {
    const rules = [
      rule('exact', 'gpt-4o', 'a', 'first'),
      rule('exact', 'a', 'b', 'second'),
    ];
    // One pass, one rule: the second rule never sees the first one's output, so a
    // pair of rules cannot oscillate depending on where they sit in the list.
    expect(rewriteModel(rules, 'gpt-4o')).toEqual({ modelId: 'a', ruleId: 'first' });
  });

  it('leaves the id alone and names no rule when nothing matches', () => {
    expect(rewriteModel([rule('exact', 'other', 'x')], 'gpt-4o')).toEqual({
      modelId: 'gpt-4o',
      ruleId: null,
    });
  });
});

describe('the chain order', () => {
  const entries = [
    { value: 'first', weight: 1 },
    { value: 'second', weight: 1 },
  ];

  it('leaves a sequential chain exactly as the operator wrote it', () => {
    expect(orderChain(entries, 'sequential', at(0.9))).toEqual(['first', 'second']);
  });

  it('moves the weighted pick to the head and keeps the tail in order', () => {
    const weighted = [
      { value: 'light', weight: 1 },
      { value: 'heavy', weight: 3 },
    ];
    // 0.9 of a total of 4 lands in the heavy entry's span, so it is tried first.
    expect(orderChain(weighted, 'round_robin', at(0.9))).toEqual(['heavy', 'light']);
    // 0.1 lands in the light one's.
    expect(orderChain(weighted, 'round_robin', at(0.1))).toEqual(['light', 'heavy']);
  });

  it('falls back to the stated order when every weight is zero', () => {
    const weightless = [
      { value: 'a', weight: 0 },
      { value: 'b', weight: 0 },
    ];
    // A combo whose weights were all zeroed is a broken record, not a reason to
    // pick at random.
    expect(orderChain(weightless, 'round_robin', at(0.5))).toEqual(['a', 'b']);
  });

  it('returns a single entry untouched under either strategy', () => {
    const one = [{ value: 'only', weight: 5 }];
    expect(orderChain(one, 'round_robin', at(0.5))).toEqual(['only']);
    expect(orderChain(one, 'sequential', at(0.5))).toEqual(['only']);
  });

  it('reads an unreadable strategy column as sequential', () => {
    // A row hand-edited outside rutekit must not silently reorder an operator's
    // fallbacks, so the fallback is the order-preserving one.
    expect(parseStrategy('weighted')).toBe('sequential');
    expect(parseStrategy('round_robin')).toBe('round_robin');
  });
});

describe('the resolver', () => {
  /** Write an alias straight through the repository, bypassing the console. */
  function alias(
    server: TestServer,
    input: { alias: string; target: string; providerId?: string | null; enabled?: boolean },
  ): void {
    const at = new Date().toISOString();
    server.aliases.create({
      id: crypto.randomUUID(),
      alias: input.alias,
      target: input.target,
      providerId: input.providerId ?? null,
      enabled: input.enabled ?? true,
      description: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  function combo(
    server: TestServer,
    input: {
      name: string;
      strategy?: 'sequential' | 'round_robin';
      fallbackOnError?: boolean;
      enabled?: boolean;
      entries: { model: string; providerId?: string | null; weight?: number; enabled?: boolean }[];
    },
  ): void {
    const at = new Date().toISOString();
    server.combos.create(
      {
        id: crypto.randomUUID(),
        name: input.name,
        displayName: input.name,
        description: null,
        strategy: input.strategy ?? 'sequential',
        fallbackOnError: input.fallbackOnError ?? true,
        enabled: input.enabled ?? true,
        createdAt: at,
        updatedAt: at,
      },
      input.entries.map((entry) => ({
        model: entry.model,
        providerId: entry.providerId ?? null,
        weight: entry.weight ?? 1,
        enabled: entry.enabled ?? true,
      })),
    );
  }

  function mapping(
    server: TestServer,
    input: {
      match: 'exact' | 'contains' | 'regex';
      pattern: string;
      replacement: string;
      priority?: number;
      enabled?: boolean;
    },
  ): void {
    const at = new Date().toISOString();
    server.mappings.create({
      id: crypto.randomUUID(),
      match: input.match,
      pattern: input.pattern,
      replacement: input.replacement,
      priority: input.priority ?? 0,
      enabled: input.enabled ?? true,
      description: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  it('resolves a curated model id with no plan at all', () => {
    const plan = server().planner.resolve('gpt-4o');

    expect(plan?.via).toBe('model');
    expect(plan?.steps[0]?.resolved.model.id).toBe('gpt-4o');
    expect(plan?.fallbackOnError).toBe(false);
  });

  it('answers null for an id nothing in rutekit knows', () => {
    expect(server().planner.resolve('no-such-model')).toBeNull();
  });

  it('rewrites the id at the edge before anything else looks at it', () => {
    const one = server();
    mapping(one, { match: 'exact', pattern: 'gpt-4o', replacement: 'gpt-4o-mini' });

    const plan = one.planner.resolve('gpt-4o');
    // FR-1.5 is a rewrite of the *question*: the resolved model is the one the
    // rule named, and the plan reports both ids so a turn can be explained.
    expect(plan?.requested).toBe('gpt-4o');
    expect(plan?.rewritten).toBe('gpt-4o-mini');
    expect(plan?.steps[0]?.resolved.model.id).toBe('gpt-4o-mini');
  });

  it('resolves an alias to its target, and honours a provider pin', () => {
    const one = server();
    alias(one, { alias: 'fast', target: 'gpt-4o-mini' });

    expect(one.planner.resolve('fast')?.via).toBe('alias');
    expect(one.planner.resolve('fast')?.steps[0]?.resolved.model.id).toBe('gpt-4o-mini');
    expect(one.planner.resolve('fast')?.steps[0]?.resolved.providerId).toBe('openai');

    alias(one, { alias: 'pinned', target: 'gpt-4o-mini', providerId: 'anthropic' });
    // A pin naming a provider that does not curate the id resolves to nothing: a
    // silent fallback to the other provider would make the pin a suggestion.
    expect(one.planner.resolve('pinned')).toBeNull();
  });

  it('ignores a disabled alias, so the name stops meaning anything', () => {
    const one = server();
    alias(one, { alias: 'fast', target: 'gpt-4o-mini', enabled: false });

    expect(one.planner.resolve('fast')).toBeNull();
  });

  it('fans a combo out into its chain, dropping entries nothing serves', () => {
    const one = server();
    combo(one, {
      name: 'daily',
      entries: [{ model: 'gpt-4o-mini' }, { model: 'stale-model' }, { model: 'claude-3-opus-20240229' }],
    });

    const plan = one.planner.resolve('daily');
    expect(plan?.via).toBe('combo');
    expect(plan?.comboName).toBe('daily');
    expect(plan?.fallbackOnError).toBe(true);
    expect(plan?.steps.map((step) => step.resolved.model.id)).toEqual([
      'gpt-4o-mini',
      'claude-3-opus-20240229',
    ]);
    // The stale row is named rather than silently forgotten: it is the difference
    // between "your combo has a typo" and "your combo is empty".
    expect(plan?.unresolved).toEqual(['stale-model']);
  });

  it('skips a disabled combo entry', () => {
    const one = server();
    combo(one, {
      name: 'daily',
      entries: [{ model: 'gpt-4o-mini', enabled: false }, { model: 'gpt-4o' }],
    });

    expect(one.planner.resolve('daily')?.steps.map((step) => step.resolved.model.id)).toEqual([
      'gpt-4o',
    ]);
  });

  it('lets an alias name a combo, because the lookup runs after the alias', () => {
    const one = server();
    combo(one, { name: 'daily', entries: [{ model: 'gpt-4o-mini' }, { model: 'gpt-4o' }] });
    alias(one, { alias: 'fast', target: 'daily' });

    const plan = one.planner.resolve('fast');
    // The pipeline is mapping → alias → combo → catalogue, and this is what that
    // ordering buys: an operator gives a client-friendly name to a whole chain.
    expect(plan?.via).toBe('combo');
    expect(plan?.comboName).toBe('daily');
    expect(plan?.steps).toHaveLength(2);
  });

  it('puts a combo ahead of a model of the same name, and says so', () => {
    const one = server();
    combo(one, { name: 'gpt-4o', entries: [{ model: 'gpt-4o-mini' }] });

    // A name that is both a combo and a curated model resolves to the combo. It is
    // the operator's own construct and the more specific statement of intent.
    expect(one.planner.resolve('gpt-4o')?.via).toBe('combo');
  });

  it('honours a mapping that rewrites onto an alias', () => {
    const one = server();
    alias(one, { alias: 'fast', target: 'gpt-4o-mini' });
    mapping(one, { match: 'exact', pattern: 'quick', replacement: 'fast' });

    const plan = one.planner.resolve('quick');
    expect(plan?.via).toBe('alias');
    expect(plan?.steps[0]?.resolved.model.id).toBe('gpt-4o-mini');
  });

  it('runs mapping rules in priority order and stops at the first match', () => {
    const one = server();
    mapping(one, { match: 'exact', pattern: 'gpt-4o', replacement: 'gpt-4o-mini', priority: 10 });
    mapping(one, { match: 'exact', pattern: 'gpt-4o', replacement: 'gpt-4.1', priority: 1 });

    // Priority 1 is the lower number, so it runs first and the higher one never
    // sees the id.
    expect(one.planner.resolve('gpt-4o')?.steps[0]?.resolved.model.id).toBe('gpt-4.1');
  });

  it('ignores a disabled mapping rule', () => {
    const one = server();
    mapping(one, {
      match: 'exact',
      pattern: 'gpt-4o',
      replacement: 'gpt-4o-mini',
      enabled: false,
    });

    expect(one.planner.resolve('gpt-4o')?.steps[0]?.resolved.model.id).toBe('gpt-4o');
  });

  it('reports a combo whose every entry is stale as an empty chain', () => {
    const one = server();
    combo(one, { name: 'broken', entries: [{ model: 'gone-a' }, { model: 'gone-b' }] });

    const plan = one.planner.resolve('broken');
    // The plan exists — the name is real — but it has nowhere to go. The
    // dispatcher is what turns that into a refusal naming the stale entries.
    expect(plan?.via).toBe('combo');
    expect(plan?.steps).toEqual([]);
    expect(plan?.unresolved).toEqual(['gone-a', 'gone-b']);
  });

  it('reads every write on the next resolve, with no cache in between', () => {
    const one = server();
    expect(one.planner.resolve('fast')).toBeNull();

    alias(one, { alias: 'fast', target: 'gpt-4o-mini' });
    expect(one.planner.resolve('fast')?.via).toBe('alias');

    // The whole reason there is no snapshot: a saved rule is in force on the very
    // next turn, with no invalidation step that could be forgotten.
    one.aliases.delete(one.aliases.listAll()[0]?.id ?? '');
    expect(one.planner.resolve('fast')).toBeNull();
  });
});
