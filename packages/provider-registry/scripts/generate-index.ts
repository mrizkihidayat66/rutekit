/**
 * Rebuild `src/providers/index.ts` from the provider files beside it.
 *
 * Run with `bun run generate`. The output is deterministic — the directory is
 * read once, provider ids are sorted, and nothing else is consulted —
 * so re-running after adding a provider produces exactly the file the previous
 * run would have produced, and a diff means someone edited the index by hand
 * (AP-6). `test/providers-index.test.ts` renders the same text and compares, so
 * a stale index is a red test rather than a surprise at boot.
 *
 * A provider file is expected to name-export a manifest matching its file name:
 * `openai.ts` exports `openai`, `google-vertex.ts` exports `googleVertex`. A
 * mismatch is a type error in the generated index, which is the earliest place
 * it can be caught.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { indexFileName, listProviders, providersDir, renderIndex } from './render-index.ts';

const providers = listProviders();
writeFileSync(join(providersDir, indexFileName), renderIndex(providers), 'utf8');
