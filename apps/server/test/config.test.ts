import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from '@server/runtime/config.ts';

/**
 * Boot configuration (C1.2).
 *
 * `parseConfig` is pure — source in, config out — so every case here is a plain
 * object rather than a mutated `process.env`. That matters: `process.env` is
 * global, and a test that writes to it leaks into every other test file in the
 * run.
 */

const ROOT = resolve('/repo');

describe('parseConfig', () => {
  it('fills every default from .env.example', () => {
    const config = parseConfig({}, ROOT);

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(7331);
    expect(config.databaseUrl).toBe(resolve(ROOT, 'data/rutekit.sqlite'));
    expect(config.dataDir).toBe(resolve(ROOT, 'data'));
    expect(config.nodeBinary).toBe('node');
    expect(config.previewIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('info');
    expect(config.encryptionKey).toBeNull();
    expect(config.authSecret).toBeNull();
    expect(config.capsolverKey).toBeNull();
    expect(config.repoRoot).toBe(ROOT);
  });

  it('documents every variable it reads', () => {
    // `.env.example` is the only place an operator learns that a setting exists,
    // and it had drifted: four variables were read by this file and documented
    // nowhere, so the only way to find them was to read the source. Comparing the
    // two lists is what stops that happening again — a variable added here
    // without a line there fails, and so does one removed here and left behind
    // in the template.
    const here = dirname(fileURLToPath(import.meta.url));
    const example = readFileSync(resolve(here, '..', '..', '..', '.env.example'), 'utf8');
    const documented = new Set(example.match(/RUTEKIT_[A-Z_]+/g) ?? []);

    // Read from the schema rather than from a list, so this cannot be satisfied
    // by updating a second list that has itself drifted.
    const source = readFileSync(resolve(here, '..', 'src', 'runtime', 'config.ts'), 'utf8');
    const read = new Set(source.match(/RUTEKIT_[A-Z_]+/g) ?? []);

    expect(read.size).toBeGreaterThan(20);
    expect([...read].filter((name) => !documented.has(name))).toEqual([]);
    expect([...documented].filter((name) => !read.has(name))).toEqual([]);
  });

  it('treats a blank secret as unset, not as an empty string', () => {
    // `.env.example` ships `RUTEKIT_ENCRYPTION_KEY=` — an empty assignment. If
    // that were parsed as a value, copying the template would fail to boot.
    const config = parseConfig(
      { RUTEKIT_ENCRYPTION_KEY: '', RUTEKIT_AUTH_SECRET: '   ', RUTEKIT_CAPSOLVER_KEY: '' },
      ROOT,
    );

    expect(config.encryptionKey).toBeNull();
    expect(config.authSecret).toBeNull();
    expect(config.capsolverKey).toBeNull();
  });

  it('keeps a real secret', () => {
    const key = 'a'.repeat(64);
    const config = parseConfig({ RUTEKIT_ENCRYPTION_KEY: key }, ROOT);

    expect(config.encryptionKey).toBe(key);
  });

  it('resolves relative paths against the repository root, not the cwd', () => {
    const config = parseConfig(
      { RUTEKIT_DATABASE_URL: './var/db.sqlite', RUTEKIT_DATA_DIR: 'var/assets' },
      ROOT,
    );

    expect(config.databaseUrl).toBe(resolve(ROOT, 'var/db.sqlite'));
    expect(config.dataDir).toBe(resolve(ROOT, 'var/assets'));
  });

  it('leaves an absolute path alone', () => {
    const absolute = resolve('/elsewhere/other.sqlite');
    const config = parseConfig({ RUTEKIT_DATABASE_URL: absolute }, ROOT);

    expect(config.databaseUrl).toBe(absolute);
  });

  it('passes :memory: through untouched', () => {
    // Not a path, and resolving it would produce a file literally named
    // ":memory:" in the repository root — which is exactly the sort of bug that
    // only shows up as a stray file in someone's checkout.
    const config = parseConfig({ RUTEKIT_DATABASE_URL: ':memory:' }, ROOT);

    expect(config.databaseUrl).toBe(':memory:');
  });

  it('coerces the numeric variables from their string form', () => {
    const config = parseConfig({ RUTEKIT_PORT: '8080', RUTEKIT_PREVIEW_INTERVAL_MS: '500' }, ROOT);

    expect(config.port).toBe(8080);
    expect(config.previewIntervalMs).toBe(500);
  });

  it('collects every problem into one error rather than the first', () => {
    let caught: unknown;
    try {
      parseConfig(
        { RUTEKIT_PORT: '99999', RUTEKIT_ENCRYPTION_KEY: 'not-hex', RUTEKIT_LOG_LEVEL: 'loud' },
        ROOT,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const issues = (caught as ConfigError).issues;
    expect(issues).toHaveLength(3);
    expect(issues.join('\n')).toContain('RUTEKIT_PORT');
    expect(issues.join('\n')).toContain('RUTEKIT_ENCRYPTION_KEY');
    expect(issues.join('\n')).toContain('RUTEKIT_LOG_LEVEL');
  });

  it('rejects an encryption key that is the wrong length', () => {
    // 64 hex characters is 32 bytes. A 63-character key is a truncation
    // mistake, and AES-256-GCM would silently take the wrong key material.
    expect(() => parseConfig({ RUTEKIT_ENCRYPTION_KEY: 'a'.repeat(63) }, ROOT)).toThrow(
      ConfigError,
    );
  });

  it('rejects a port outside the usable range', () => {
    expect(() => parseConfig({ RUTEKIT_PORT: '0' }, ROOT)).toThrow(ConfigError);
    expect(() => parseConfig({ RUTEKIT_PORT: '65536' }, ROOT)).toThrow(ConfigError);
    expect(() => parseConfig({ RUTEKIT_PORT: 'seven' }, ROOT)).toThrow(ConfigError);
  });

  it('names the offending variable in the message', () => {
    expect(() => parseConfig({ RUTEKIT_PORT: 'nope' }, ROOT)).toThrow(/RUTEKIT_PORT/);
  });
});

// `repoRoot()` is not asserted above: it reads `import.meta.dir`, which the test
// runner's transform does not provide, so calling it would throw for a reason
// that has nothing to do with whether the code is right. It is exercised by
// every real boot instead — a wrong root puts the database somewhere surprising,
// which is immediately visible.
