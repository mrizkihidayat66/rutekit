import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  indexFileName,
  listProviders,
  providersDir,
  renderIndex,
  toSymbol,
} from '../scripts/render-index.ts';

const onDisk = readFileSync(join(providersDir, indexFileName), 'utf8');
const providers = listProviders();

/**
 * The index is generated, so the only thing worth asserting is that the file in
 * the tree is the file the generator would produce right now. Rendering through
 * `render-index.ts` rather than re-stating the format here is what makes the
 * comparison meaningful: a test that spelled the format out itself would agree
 * with itself and disagree with the generator, which is the failure this exists
 * to catch.
 */
describe('generated providers index', () => {
  it('is exactly what the generator would write', () => {
    expect(onDisk).toBe(renderIndex(providers));
  });

  it('is not empty, so a directory-listing regression cannot pass quietly', () => {
    expect(providers.length).toBeGreaterThan(0);
    expect(onDisk).toContain('export const providerManifests');
  });

  it('lists each provider file once, alphabetically', () => {
    const ids = providers.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  it('imports every provider file it lists', () => {
    for (const provider of providers) {
      expect(onDisk).toContain(`from './${provider.id}.ts'`);
      expect(onDisk).toContain(`  ${provider.symbol},`);
    }
  });

  it('renders the same text twice', () => {
    expect(renderIndex(listProviders())).toBe(renderIndex(listProviders()));
  });
});

describe('toSymbol', () => {
  it('leaves a name with no dashes alone', () => {
    expect(toSymbol('openai')).toBe('openai');
  });

  it('camel-cases each dash-separated part', () => {
    expect(toSymbol('google-vertex')).toBe('googleVertex');
    expect(toSymbol('comfyui-local')).toBe('comfyuiLocal');
    expect(toSymbol('a-b-c')).toBe('aBC');
  });
});
