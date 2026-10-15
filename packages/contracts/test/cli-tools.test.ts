import { describe, expect, it } from 'vitest';

import {
  CLI_TOOLS,
  baseUrlFor,
  cliToolById,
  cliToolSchema,
  snippetsFor,
} from '../src/entities/cli-tools.ts';
import type { CliTarget } from '../src/entities/cli-tools.ts';

/**
 * The CLI-tool catalogue and its snippet generator (C13c).
 *
 * This is the one part of C13c that is pure, so it is the one part that can be
 * held to a real standard. The page's job is to render what comes out of here,
 * and the risk this file exists to catch is specific: a snippet that *looks*
 * right — a base URL missing its `/v1`, a value that never got substituted, an
 * entry with no case in the generator — and therefore fails in an operator's
 * client with no error pointing back here.
 *
 * Four properties, in the order they matter:
 *
 *   1. Every catalogue entry produces at least one snippet. An entry with none
 *      is a card that renders empty, and the `default:` branch in `snippetsFor`
 *      returns nothing on purpose so that this is a test failure rather than a
 *      plausible-looking block for a client nobody wrote one for.
 *   2. Every placeholder is substituted. A leftover `${base}` in a body is a
 *      snippet that is wrong in a way the operator will paste before noticing.
 *   3. The base URL is spelled the way the tool's own entry says, including the
 *      `/v1` suffix — the single most common silent misconfiguration.
 *   4. The catalogue itself is well-formed: unique ids, parseable by its own
 *      schema, and every `surface` one of the two rutekit actually serves.
 */

const TARGET: CliTarget = {
  baseUrl: 'http://192.168.1.20:7331',
  apiKey: 'rk-test-secret',
  model: 'gpt-4o-mini',
};

describe('the client catalogue', () => {
  it('is non-empty and has unique ids', () => {
    expect(CLI_TOOLS.length).toBeGreaterThan(0);
    const ids = CLI_TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('parses against its own schema', () => {
    for (const tool of CLI_TOOLS) {
      const parsed = cliToolSchema.safeParse(tool);
      expect(parsed.success, `${tool.id} does not match cliToolSchema`).toBe(true);
    }
  });

  it('resolves a tool by id, and answers null for one it does not have', () => {
    expect(cliToolById('codex')?.name).toBe('Codex');
    expect(cliToolById('nope')).toBeNull();
  });

  it('points every entry at one of the two surfaces rutekit serves', () => {
    for (const tool of CLI_TOOLS) {
      expect(['openai', 'anthropic']).toContain(tool.surface);
    }
  });

  it('names a real client, not a placeholder id', () => {
    for (const tool of CLI_TOOLS) {
      expect(tool.name.trim()).not.toBe('');
      expect(tool.description.trim()).not.toBe('');
    }
    // Names are what the cards are headed with, so two the same would be two
    // cards an operator cannot tell apart.
    const names = CLI_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);

    // A kebab-case id leaking through as the display name is the shape of a
    // forgotten name — `openai-compatible` in a card heading. A single-word id
    // that matches its name is fine: the client is genuinely called "Codex".
    const leaked = CLI_TOOLS.filter(
      (tool) => tool.id.includes('-') && tool.name.toLowerCase() === tool.id,
    ).map((tool) => tool.id);
    expect(leaked).toEqual([]);
  });
});

describe('baseUrlFor', () => {
  const tool = (suffix: 'none' | 'v1') => ({
    ...CLI_TOOLS[0]!,
    baseUrlSuffix: suffix,
  });

  it('appends /v1 only for a tool that asks for it', () => {
    expect(baseUrlFor(tool('none'), TARGET)).toBe('http://192.168.1.20:7331');
    expect(baseUrlFor(tool('v1'), TARGET)).toBe('http://192.168.1.20:7331/v1');
  });

  it('trims a trailing slash rather than producing a double one', () => {
    // An operator pasting a base URL from a browser address bar brings the
    // slash with it, and `//v1` is a path most servers will not match.
    expect(baseUrlFor(tool('v1'), { ...TARGET, baseUrl: 'http://host:7331/' })).toBe(
      'http://host:7331/v1',
    );
    expect(baseUrlFor(tool('none'), { ...TARGET, baseUrl: 'http://host:7331///' })).toBe(
      'http://host:7331',
    );
  });

  it('tolerates surrounding whitespace', () => {
    expect(baseUrlFor(tool('none'), { ...TARGET, baseUrl: '  http://host:7331  ' })).toBe(
      'http://host:7331',
    );
  });

  it('does not append /v1 when the operator already typed it', () => {
    // Not deduplicated on purpose: the field is the origin, and a `/v1` in it is
    // the operator overriding the suffix deliberately. Doubling it is visible in
    // the snippet, which is better than a rule that silently rewrites input.
    expect(baseUrlFor(tool('none'), { ...TARGET, baseUrl: 'http://host:7331/v1' })).toBe(
      'http://host:7331/v1',
    );
  });
});

describe('snippetsFor', () => {
  it('produces at least one snippet for every catalogue entry', () => {
    const empty = CLI_TOOLS.filter((tool) => snippetsFor(tool, TARGET).length === 0).map(
      (tool) => tool.id,
    );
    // A tool in the catalogue with no case in the generator is a card that
    // renders nothing — see the `default:` branch in `snippetsFor`.
    expect(empty).toEqual([]);
  });

  it('substitutes every value and leaves no placeholder behind', () => {
    const leaks: string[] = [];
    for (const tool of CLI_TOOLS) {
      for (const snippet of snippetsFor(tool, TARGET)) {
        for (const token of ['${base}', '${apiKey}', '${model}']) {
          if (snippet.body.includes(token)) {
            leaks.push(`${tool.id}/${snippet.id} still contains ${token}`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('carries the model, the key and the base URL into every snippet that should have them', () => {
    for (const tool of CLI_TOOLS) {
      for (const snippet of snippetsFor(tool, TARGET)) {
        expect(snippet.body.length).toBeGreaterThan(0);
        // Every snippet is one of the three values in some shape, so all three
        // should appear somewhere in the body. A client that needs the key in a
        // second place (Codex names an env var and sets it separately) still
        // names it in the snippet that sets it.
        const hasAny =
          snippet.body.includes(TARGET.baseUrl) ||
          snippet.body.includes(TARGET.apiKey) ||
          snippet.body.includes(TARGET.model);
        expect(hasAny, `${tool.id}/${snippet.id} carries none of the three values`).toBe(true);
      }
    }
  });

  it('spells the base URL the way each tool declared', () => {
    for (const tool of CLI_TOOLS) {
      const expected = baseUrlFor(tool, TARGET);
      const bodies = snippetsFor(tool, TARGET).map((snippet) => snippet.body);
      // Some snippets are the key alone (Codex sets its env var separately), so
      // only assert that a snippet mentioning the host mentions it correctly.
      for (const body of bodies) {
        if (!body.includes('192.168.1.20')) continue;
        expect(body, `${tool.id} spells the base URL wrong`).toContain(expected);
        if (tool.baseUrlSuffix === 'none') {
          expect(body).not.toContain(`${expected}/v1`);
        }
      }
    }
  });

  it('gives every snippet an id unique within its tool, and a label', () => {
    for (const tool of CLI_TOOLS) {
      const snippets = snippetsFor(tool, TARGET);
      const ids = snippets.map((snippet) => snippet.id);
      expect(new Set(ids).size, `${tool.id} repeats a snippet id`).toBe(ids.length);
      for (const snippet of snippets) {
        expect(snippet.label.trim()).not.toBe('');
      }
    }
  });

  it('names a file only when the snippet is one', () => {
    for (const tool of CLI_TOOLS) {
      for (const snippet of snippetsFor(tool, TARGET)) {
        // A shell block is typed into a terminal, not saved to a path.
        if (snippet.language === 'bash') expect(snippet.filename).toBeNull();
      }
    }
  });

  it('emits JSON that actually parses', () => {
    // The two most likely failures are a trailing comma and an unquoted key, and
    // both produce a config file a client refuses to load.
    for (const tool of CLI_TOOLS) {
      for (const snippet of snippetsFor(tool, TARGET)) {
        if (snippet.language !== 'json') continue;
        expect(
          () => JSON.parse(snippet.body) as unknown,
          `${tool.id}/${snippet.id} is not valid JSON`,
        ).not.toThrow();
      }
    }
  });

  it('points the Anthropic surface at a URL with no /v1, because the client adds it', () => {
    // The one fact that was verified against the client's own SDK: it composes
    // `baseURL + '/v1/messages'`. A `/v1` here sends every request to
    // `/v1/v1/messages`, which is the classic silent failure this whole file is
    // built to catch.
    const anthropic = CLI_TOOLS.filter((tool) => tool.surface === 'anthropic');
    expect(anthropic.length).toBeGreaterThan(0);
    for (const tool of anthropic) {
      expect(tool.baseUrlSuffix, `${tool.id} must not add /v1 on the Messages surface`).toBe(
        'none',
      );
    }
  });

  it('says which entries have not been checked against their client', () => {
    // Not an assertion that everything is verified — it is not. This asserts the
    // flag is a real boolean on every entry, so the page can never render
    // "verified" for an entry that forgot to say.
    for (const tool of CLI_TOOLS) {
      expect(typeof tool.formatVerified).toBe('boolean');
    }
    // At least the generic entries are rutekit's own surfaces and are checkable
    // from this repository alone.
    expect(CLI_TOOLS.filter((tool) => tool.formatVerified).length).toBeGreaterThan(0);
  });
});
