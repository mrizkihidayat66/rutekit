/**
 * What the command line was asked to do.
 *
 * Parsed by hand rather than with a library: the surface is three verbs and two
 * flags, and a dependency that has to be kept in step with a `--help` text is a
 * bigger thing to own than a switch. It is also the part of a CLI that is worth
 * testing, so keeping it pure and separate from `process.argv` is the point of
 * this file — `parseArgs` takes an array and returns a value, and the entrypoint
 * is the only thing that touches the process.
 */

export type Command =
  | { readonly kind: 'start'; readonly port: number | null; readonly host: string | null }
  | { readonly kind: 'init'; readonly force: boolean }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly message: string };

export const USAGE = `rutekit — self-hosted AI router

Usage
  rutekit                 Start the instance
  rutekit init            Write a .env with freshly generated secrets
  rutekit --help          This text
  rutekit --version       Print the version

Options
  --port <n>              Bind to a different port (default 7331)
  --host <addr>           Bind to a different address (default 127.0.0.1)
  --force                 \`init\`: overwrite an existing .env

Environment
  Every setting is a RUTEKIT_* variable; see .env.example for the list.
  An instance started with no .env still runs — it stores its database in
  ./data and warns about the two secrets it is missing.
`;

/** The two flags that take a value, so a bare `--port` can be reported. */
const VALUED = ['--port', '--host'] as const;

export function parseArgs(argv: readonly string[]): Command {
  let port: number | null = null;
  let host: string | null = null;
  let force = false;
  let verb: 'start' | 'init' | 'help' | 'version' = 'start';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--version' || arg === '-v') return { kind: 'version' };
    if (arg === '--force') {
      force = true;
      continue;
    }

    if (arg === '--port' || arg === '--host') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return { kind: 'error', message: `${arg} needs a value.` };
      }
      index += 1;

      if (arg === '--port') {
        // `Number`, not `parseInt`: `parseInt('80.5', 10)` is 80, so a fractional
        // port would be silently truncated to a number nobody asked for. The
        // integer check below is what makes that a refusal instead.
        const parsed = Number(value);
        // Checked here rather than left to the server's config schema: a port
        // that is not a number is a typo at the command line, and the message
        // should say so instead of surfacing as a config validation error.
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
          return {
            kind: 'error',
            message: `--port needs a number from 1 to 65535, got "${value}".`,
          };
        }
        port = parsed;
      } else {
        host = value;
      }
      continue;
    }

    if (arg === 'init') {
      verb = 'init';
      continue;
    }

    // Anything else is a typo, and guessing what it meant is how a CLI ends up
    // starting a server when the operator asked it to do something else.
    return {
      kind: 'error',
      message: `Unknown ${arg.startsWith('-') ? 'option' : 'command'} "${arg}".`,
    };
  }

  if (verb === 'init') return { kind: 'init', force };
  return { kind: 'start', port, host };
}

/** Whether `--port`/`--host` were given, so a start can say it is overriding. */
export function valuedFlags(argv: readonly string[]): readonly string[] {
  return VALUED.filter((flag) => argv.includes(flag));
}
