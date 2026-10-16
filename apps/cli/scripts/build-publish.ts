/**
 * Build the npm package: `dist/npm/`.
 *
 * Three things have to be assembled together, and the reason they are one script is
 * that the published package is only correct when all three agree:
 *
 * 1. **The bundle.** `bun build` inlines the CLI, the server and every `@rutekit/*`
 *    workspace package into one file. That is what makes publishing possible at all —
 *    the workspace packages are `workspace:*` and would not resolve from the registry,
 *    so shipping them as separate packages is the alternative, and this avoids it.
 * 2. **The console.** `apps/web/dist` is copied in as `console/`, which is where
 *    `locateConsole` looks for a build shipped beside a bundle.
 * 3. **A manifest.** Written here rather than copied from `apps/cli`, because the
 *    published shape differs: the bin points at the bundle instead of the TypeScript
 *    entry, and the dependency list is the handful of packages that stayed external.
 *
 * The npm packages are left external on purpose. They are real packages with real
 * versions, and bundling them would freeze them at whatever this build resolved —
 * which is the opposite of what a dependency list is for.
 *
 * **`promptfoo` is optional.** It is resolved lazily through `createRequire`, never
 * imported at load time, so nothing needs it until a benchmark actually runs. Making
 * it a hard dependency would add tens of megabytes to every install for a feature
 * most operators never open.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const OUT = join(ROOT, 'dist', 'npm');
const CONSOLE_SOURCE = join(ROOT, 'apps', 'web', 'dist');
const ENTRY = join(ROOT, 'apps', 'cli', 'src', 'index.ts');

/** Kept out of the bundle: real packages, resolved from the registry at install time. */
const EXTERNAL = ['@hono/zod-validator', 'drizzle-orm', 'hono', 'pino', 'zod'];

/** Needed only when a benchmark runs, and it is large. */
const OPTIONAL = ['promptfoo'];

function fail(message: string): never {
  process.stderr.write(`build-publish: ${message}\n`);
  process.exit(1);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

const cliManifest = await readJson(join(ROOT, 'apps', 'cli', 'package.json'));
const serverManifest = await readJson(join(ROOT, 'apps', 'server', 'package.json'));

const serverDeps = (serverManifest.dependencies ?? {}) as Record<string, string>;
const version = cliManifest.version;
if (typeof version !== 'string') fail('apps/cli/package.json has no version.');

const dependencies: Record<string, string> = {};
for (const name of EXTERNAL) {
  const range = serverDeps[name];
  if (range === undefined) fail(`${name} is not a dependency of @rutekit/server.`);
  dependencies[name] = range;
}

const optionalDependencies: Record<string, string> = {};
for (const name of OPTIONAL) {
  const range = serverDeps[name];
  if (range === undefined) fail(`${name} is not a dependency of @rutekit/server.`);
  optionalDependencies[name] = range;
}

// The console is built separately, and a missing one is the difference between a
// package that serves a console and one whose root 404s — so it is an error, not a
// warning.
const consoleIndex = join(CONSOLE_SOURCE, 'index.html');
if (!(await Bun.file(consoleIndex).exists())) {
  fail(`the console is not built: ${consoleIndex} is missing. Run \`bun run build:web\` first.`);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const build = Bun.spawnSync(
  [
    'bun',
    'build',
    ENTRY,
    '--target=bun',
    `--outfile=${join(OUT, 'rutekit.js')}`,
    ...EXTERNAL.map((name) => `--external=${name}`),
    ...OPTIONAL.map((name) => `--external=${name}`),
  ],
  { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
);
if (build.exitCode !== 0) fail('the bundle failed to build.');

// Source maps are excluded on purpose. They are development artifacts, they are the
// bulk of the build — hundreds of files and tens of megabytes — and nothing that serves
// the console ever asks for one. Publishing them would multiply the package size for a
// debugging aid the browser only fetches when devtools is open.
await cp(CONSOLE_SOURCE, join(OUT, 'console'), {
  recursive: true,
  filter: (source) => !source.endsWith('.map'),
});

const manifest = {
  name: 'rutekit',
  version,
  description:
    'Self-hosted AI router and gateway — one [OI]-compatible endpoint in front of many provider accounts.',
  license: 'MIT',
  type: 'module',
  bin: { rutekit: './rutekit.js' },
  files: ['rutekit.js', 'console'],
  engines: { bun: '>=1.2.0' },
  dependencies,
  optionalDependencies,
  keywords: [
    'ai',
    'gateway',
    'router',
    'llm',
    'openai-compatible',
    'self-hosted',
    'anthropic',
  ],
  repository: {
    type: 'git',
    url: 'git+https://github.com/mrizkihidayat66/rutekit.git',
  },
  homepage: 'https://github.com/mrizkihidayat66/rutekit#readme',
  bugs: { url: 'https://github.com/mrizkihidayat66/rutekit/issues' },
};

await writeFile(join(OUT, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// The bin has to be executable and carry a shebang, or `bunx rutekit` cannot run it.
const bundle = Bun.file(join(OUT, 'rutekit.js'));
const firstLine = (await bundle.text()).split('\n', 1)[0] ?? '';
if (!firstLine.startsWith('#!')) {
  fail('the bundle has no shebang, so it cannot be used as a bin.');
}

const consoleFiles = Array.from(
  new Bun.Glob('**/*').scanSync({ cwd: join(OUT, 'console') }),
).length;

process.stdout.write(
  `built dist/npm\n` +
    `  rutekit@${version}\n` +
    `  rutekit.js  ${(bundle.size / 1024 / 1024).toFixed(2)} MB\n` +
    `  console/    ${String(consoleFiles)} files\n` +
    `  deps        ${Object.keys(dependencies).join(', ')}\n` +
    `  optional    ${Object.keys(optionalDependencies).join(', ')}\n`,
);
