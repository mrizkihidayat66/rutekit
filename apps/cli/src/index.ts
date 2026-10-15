#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { main } from '@rutekit/server';
import { USAGE, parseArgs } from './args.ts';
import { init } from './init.ts';

/**
 * The `rutekit` command (D3).
 *
 * Three verbs and a server. The server is started **in-process** rather than
 * spawned: `@rutekit/server` exports `main`, and the call at the bottom of that
 * file is guarded by `import.meta.main`, so importing it to call `main()` does
 * not boot anything on the way in. Spawning would have meant a second process to
 * forward signals to and a path to the server's entry that has to survive being
 * published — for no benefit, since the CLI has nothing to do while the server
 * runs.
 *
 * **`--port` and `--host` are applied as environment variables**, before the
 * server reads its configuration. That is the same door `.env` goes through, so
 * there is one place that decides what the config is rather than two that can
 * disagree. The flag is a convenience over editing the file, not a second
 * configuration system.
 *
 * `--help` and `--version` answer without starting anything, which is the reason
 * the entry call in `main.ts` is guarded at all.
 */

/**
 * The version the package declares, so the two cannot drift.
 *
 * Read from disk rather than imported: a JSON import is resolved at bundle time
 * and would report whatever the version was when the bundle was built. A missing
 * or unreadable manifest is not worth failing a `--version` over, so it falls
 * back to the placeholder the root package uses.
 */
function version(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function fail(message: string): never {
  process.stderr.write(`rutekit: ${message}\n\nRun \`rutekit --help\` for usage.\n`);
  process.exit(2);
}

function run(): void {
  const command = parseArgs(process.argv.slice(2));

  switch (command.kind) {
    case 'help':
      process.stdout.write(USAGE);
      return;

    case 'version':
      process.stdout.write(`${version()}\n`);
      return;

    case 'error':
      fail(command.message);

    // eslint-disable-next-line no-fallthrough -- `fail` returns `never`.
    case 'init': {
      const result = init({ cwd: process.cwd(), force: command.force });
      if (!result.ok) fail(result.reason ?? 'init refused.');
      process.stdout.write(
        `Wrote ${result.path}\n\n` +
          'It holds two generated secrets and is chmod 600. Start the instance with `rutekit`.\n',
      );
      return;
    }

    case 'start': {
      if (command.port !== null) process.env.RUTEKIT_PORT = String(command.port);
      if (command.host !== null) process.env.RUTEKIT_HOST = command.host;
      // The server owns its own signal handling and shutdown sequence; this only
      // has to not get in the way.
      main();
      return;
    }
  }
}

run();
