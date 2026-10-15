/**
 * The text of `src/providers/index.ts`, and the directory listing it is built
 * from — everything `generate-index.ts` does except the writing.
 *
 * Kept apart from the CLI so the staleness test can render the index the same
 * way the generator does. A test that re-implemented the format would agree with
 * itself and disagree with the generator, which is the failure it exists to
 * catch.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `src/providers/`, resolved from this file rather than from the cwd. */
export const providersDir = fileURLToPath(new URL('../src/providers/', import.meta.url));

export const indexFileName = 'index.ts';

const HEADER = `// AUTO-GENERATED — DO NOT EDIT (AP-6).
//
// One entry per provider file in this directory, rebuilt by \`bun run generate\`
// in \`packages/provider-registry\`. Hand edits are overwritten, and a stale index
// fails \`test/providers-index.test.ts\` — edit a provider file instead.
//
// The order is alphabetical by provider id, which is the console's catalogue order.
// Grouping is the console's job, not this file's.
`;

export interface ProviderEntry {
  /** File stem, which is also the provider id. */
  readonly id: string;
  /** The identifier the file exports it under. */
  readonly symbol: string;
}

/** `google-vertex` → `googleVertex`; a name with no dashes is left alone. */
export function toSymbol(id: string): string {
  return id
    .split('-')
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/** Every provider file in the directory, in the order the index lists them. */
export function listProviders(dir: string = providersDir): ProviderEntry[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && name !== indexFileName)
    .map((name) => name.slice(0, -'.ts'.length))
    .sort()
    .map((id) => ({ id, symbol: toSymbol(id) }));
}

export function renderIndex(list: readonly ProviderEntry[]): string {
  const imports = list
    .map((entry) => `import { ${entry.symbol} } from './${entry.id}.ts';`)
    .join('\n');
  const values = list.map((entry) => `  ${entry.symbol},`).join('\n');
  const block = imports === '' ? '' : `\n${imports}\n`;

  return `${HEADER}
import type { ProviderManifestInput } from '../manifest.ts';
${block}
export const providerManifests: readonly ProviderManifestInput[] = [
${values}
];
`;
}
