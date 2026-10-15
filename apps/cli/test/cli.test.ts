import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { USAGE, parseArgs } from '../src/args.ts';
import { envFile, generateSecret, hasEncryptionKey, init } from '../src/init.ts';

/**
 * The CLI's two pure halves: what the arguments meant, and what `init` writes.
 *
 * Both are separated from the process on purpose, which is what makes them
 * testable at all — `parseArgs` takes an array rather than reading `argv`, and
 * `init` takes a directory rather than using the working one. The entrypoint is
 * the only thing that touches either, and it is four lines per verb.
 *
 * The `init` cases are the ones worth having. Two of them are about a mistake
 * that cannot be undone: an `.env` holds the key every stored credential is
 * encrypted under, so overwriting one without being asked would leave an
 * operator with a database full of values that will never decrypt.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rutekit-cli-'));
}

describe('parseArgs', () => {
  it('starts by default', () => {
    expect(parseArgs([])).toEqual({ kind: 'start', port: null, host: null });
  });

  it('reads the two flags that take a value', () => {
    expect(parseArgs(['--port', '8080', '--host', '0.0.0.0'])).toEqual({
      kind: 'start',
      port: 8080,
      host: '0.0.0.0',
    });
  });

  it('answers help and version without starting anything', () => {
    for (const flag of ['--help', '-h']) expect(parseArgs([flag])).toEqual({ kind: 'help' });
    for (const flag of ['--version', '-v']) expect(parseArgs([flag])).toEqual({ kind: 'version' });
  });

  it('reads init, and its force flag', () => {
    expect(parseArgs(['init'])).toEqual({ kind: 'init', force: false });
    expect(parseArgs(['init', '--force'])).toEqual({ kind: 'init', force: true });
  });

  it('lets help win over everything else', () => {
    // `rutekit init --help` is someone asking what `init` does, not asking for an
    // `.env`. Answering with the file would be the least useful reading.
    expect(parseArgs(['init', '--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--port', '1', '--help'])).toEqual({ kind: 'help' });
  });

  it('reports a flag that is missing its value rather than guessing', () => {
    const missing = parseArgs(['--port']);
    expect(missing.kind).toBe('error');
    // The next argument starting with `-` is another flag, not a value.
    expect(parseArgs(['--port', '--host']).kind).toBe('error');
  });

  it('refuses a port that is not a usable number', () => {
    for (const bad of ['abc', '0', '65536', '-1', '80.5']) {
      const result = parseArgs(['--port', bad]);
      expect(result.kind, `--port ${bad} was accepted`).toBe('error');
    }
  });

  it('refuses an unknown option or command', () => {
    // Guessing is how a CLI starts a server when the operator asked for something
    // else, so an unrecognised word is an error rather than a no-op.
    expect(parseArgs(['--wat']).kind).toBe('error');
    expect(parseArgs(['server']).kind).toBe('error');
    expect(parseArgs(['init', 'extra']).kind).toBe('error');
  });

  it('names what it did not understand', () => {
    const result = parseArgs(['--nope']);
    expect(result.kind === 'error' && result.message).toContain('--nope');
  });

  it('documents every verb it accepts', () => {
    // A `--help` that has drifted from the parser is worse than none, because it
    // is the thing an operator trusts. Every word the parser knows appears in it.
    for (const word of ['init', '--port', '--host', '--force', '--version']) {
      expect(USAGE, `${word} is missing from --help`).toContain(word);
    }
  });
});

describe('generateSecret', () => {
  it('produces 32 bytes of hex', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toBe(generateSecret());
  });
});

describe('init', () => {
  it('writes a .env carrying both generated secrets', () => {
    const cwd = tempDir();

    const result = init({ cwd, force: false, generate: () => 'ab'.repeat(32) });

    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(cwd, '.env'));
    const written = readFileSync(result.path, 'utf8');
    expect(written).toContain(`RUTEKIT_ENCRYPTION_KEY=${'ab'.repeat(32)}`);
    expect(written).toContain(`RUTEKIT_AUTH_SECRET=${'ab'.repeat(32)}`);
  });

  it('generates the two secrets separately', () => {
    // The same value for both would be a real weakening and is exactly what a
    // single `generate()` call used twice would produce if it were memoised.
    const cwd = tempDir();
    let calls = 0;
    const result = init({
      cwd,
      force: false,
      generate: () => {
        calls += 1;
        return `secret${String(calls)}`.padEnd(64, '0');
      },
    });

    const written = readFileSync(result.path, 'utf8');
    const key = /^RUTEKIT_ENCRYPTION_KEY=(.+)$/m.exec(written)?.[1];
    const auth = /^RUTEKIT_AUTH_SECRET=(.+)$/m.exec(written)?.[1];
    expect(key).toBeDefined();
    expect(auth).toBeDefined();
    expect(key).not.toBe(auth);
  });

  it('refuses to overwrite an existing .env', () => {
    // The one mistake in the file that cannot be undone: regenerating the key
    // makes every stored credential undecryptable, and the data still looks fine.
    const cwd = tempDir();
    writeFileSync(join(cwd, '.env'), 'RUTEKIT_ENCRYPTION_KEY=keep-me\n', 'utf8');

    const result = init({ cwd, force: false, generate: () => 'ff'.repeat(32) });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('--force');
    expect(readFileSync(join(cwd, '.env'), 'utf8')).toContain('keep-me');
  });

  it('overwrites when told to', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, '.env'), 'RUTEKIT_ENCRYPTION_KEY=old\n', 'utf8');

    const result = init({ cwd, force: true, generate: () => 'cd'.repeat(32) });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(cwd, '.env'), 'utf8')).toContain('cd'.repeat(32));
  });

  it('writes a file an operator can read without being told what to do', () => {
    // It is the first file a new operator opens, so the key it must not lose is
    // named in it rather than only in the docs.
    const cwd = tempDir();
    const result = init({ cwd, force: false, generate: () => 'ab'.repeat(32) });
    const written = readFileSync(result.path, 'utf8');

    expect(written).toContain('cannot decrypt them');
    expect(written).toContain('RUTEKIT_PORT=7331');
  });
});

describe('envFile', () => {
  it('is a function of the two secrets and nothing else', () => {
    expect(envFile('a', 'b')).toBe(envFile('a', 'b'));
    expect(envFile('a', 'b')).not.toBe(envFile('a', 'c'));
  });
});

describe('hasEncryptionKey', () => {
  it('is false when there is no file, and when the key is blank', () => {
    const cwd = tempDir();
    expect(hasEncryptionKey(join(cwd, '.env'))).toBe(false);

    writeFileSync(join(cwd, '.env'), 'RUTEKIT_ENCRYPTION_KEY=\n', 'utf8');
    expect(hasEncryptionKey(join(cwd, '.env'))).toBe(false);
  });

  it('is true once init has written one', () => {
    const cwd = tempDir();
    const result = init({ cwd, force: false });

    expect(hasEncryptionKey(result.path)).toBe(true);
  });
});
