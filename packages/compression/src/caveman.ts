import type { CavemanTier } from '@contracts';
import type { CanonicalRequest } from '@translator';

import type { CompressionStage, StageContext, StageOutcome } from './types.ts';

/**
 * Caveman — the system prompt, tightened.
 *
 * The only stage that touches the operator's own instructions, which is why it
 * is opt-in and why its tier is explicit rather than automatic. The three tiers
 * are cumulative:
 *
 *   - `lite` normalises whitespace and collapses blank runs.
 *   - `full` also drops filler lines and consecutive repeats.
 *   - `ultra` also unwraps paragraphs and removes blank lines entirely.
 *
 * The rewrite is deterministic and local — no model call, no network, no
 * variation between two identical requests. A rule-based pass can be reasoned
 * about and its output diffed; a model-driven one could not, and would add a
 * round-trip to save a round-trip.
 *
 * Fenced code is never touched. An instruction's example block is data, and
 * rewriting it would change what the prompt teaches.
 */

const FILLER =
  /^(please|thanks|thank you|note:|as an ai\b|it is important to note that\b|keep in mind that\b)/i;

interface Segment {
  readonly fenced: boolean;
  readonly value: string;
}

function splitFences(text: string): Segment[] {
  const segments: Segment[] = [];
  let buffer: string[] = [];
  let fenced = false;

  for (const row of text.split('\n')) {
    const isFence = /^\s*```/.test(row);
    if (isFence && !fenced) {
      if (buffer.length > 0) segments.push({ fenced: false, value: buffer.join('\n') });
      buffer = [row];
      fenced = true;
    } else if (isFence) {
      buffer.push(row);
      segments.push({ fenced: true, value: buffer.join('\n') });
      buffer = [];
      fenced = false;
    } else {
      buffer.push(row);
    }
  }

  if (buffer.length > 0) segments.push({ fenced, value: buffer.join('\n') });
  return segments;
}

function collapseBlankRuns(rows: readonly string[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row === '' && out[out.length - 1] === '') continue;
    out.push(row);
  }
  return out;
}

const isListRow = (row: string): boolean => /^\s*([-*+•]|\d+[.)]|#)/.test(row);

/** Join wrapped prose back into one line, leaving bullets and headings alone. */
function unwrap(rows: readonly string[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (row === '' || isListRow(row) || last === undefined || last === '' || isListRow(last)) {
      out.push(row);
      continue;
    }
    out[out.length - 1] = `${last} ${row.trim()}`;
  }
  return out;
}

function tightenProse(value: string, tier: CavemanTier): string {
  let rows = value.split('\n').map((row) => row.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' '));
  rows = collapseBlankRuns(rows);
  if (tier === 'lite') return rows.join('\n');

  rows = rows.filter((row, index) => !FILLER.test(row.trim()) && row !== rows[index - 1]);
  if (tier === 'full') return rows.join('\n');

  return unwrap(rows)
    .filter((row) => row !== '')
    .join('\n');
}

function tighten(text: string, tier: CavemanTier): string {
  return splitFences(text)
    .map((segment) => (segment.fenced ? segment.value : tightenProse(segment.value, tier)))
    .join('\n');
}

export const cavemanStage: CompressionStage = {
  id: 'caveman',
  nature: 'lossy',

  apply(request: CanonicalRequest, context: StageContext): StageOutcome | null {
    if (context.cavemanTier === 'off' || request.system.length === 0) return null;

    let changed = false;
    const system = request.system.map((block) => {
      const text = tighten(block.text, context.cavemanTier);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    });

    return changed ? { request: { ...request, system } } : null;
  },
};
