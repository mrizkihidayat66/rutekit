import type { RtkFilterId } from '@contracts';

/**
 * The twelve RTK filters, one per shape of tool result.
 *
 * A filter is a detector plus a transform. The detector is deliberately narrow:
 * it decides whether a result *is* this shape, so the transform can be written
 * without defending against text it was never meant for. The pipeline tries the
 * enabled filters in order and stops at the first that recognises the text, so a
 * filter that over-claims steals results from the one that fits better.
 *
 * Every transform is a pure string-to-string function, and none of them may
 * throw on unexpected input — the stage is fail-open, but a filter that returns
 * its input unchanged is still better than one that costs the pipeline a
 * try/catch.
 */

export interface RtkFilter {
  readonly id: RtkFilterId;
  detect(text: string): boolean;
  apply(text: string): string;
}

const lines = (text: string): string[] => text.split('\n');

/** Head-and-tail with a marker where the middle went; the blunt instruments. */
function cap(rows: readonly string[], head: number, tail: number): string[] {
  if (rows.length <= head + tail + 1) return [...rows];
  const removed = rows.length - head - tail;
  return [...rows.slice(0, head), `… ${removed} lines omitted …`, ...rows.slice(rows.length - tail)];
}

const GREP_MATCHES_PER_FILE = 5;

const isDiffHeader = (row: string): boolean =>
  row.startsWith('diff --git') ||
  row.startsWith('index ') ||
  row.startsWith('--- ') ||
  row.startsWith('+++ ') ||
  row.startsWith('@@');

/** `git diff` — keep the hunks, drop the unchanged context lines between them. */
const gitDiff: RtkFilter = {
  id: 'gitDiff',
  detect: (text) => /^diff --git /m.test(text) || (/^@@ /m.test(text) && /^\+\+\+ /m.test(text)),
  apply: (text) =>
    lines(text)
      .filter(
        (row) =>
          isDiffHeader(row) ||
          ((row.startsWith('+') || row.startsWith('-')) &&
            !row.startsWith('+++') &&
            !row.startsWith('---')),
      )
      .join('\n'),
};

/** `git status` — the file lists and their headers, without the "use git add" hints. */
const gitStatus: RtkFilter = {
  id: 'gitStatus',
  detect: (text) =>
    /^On branch /m.test(text) ||
    /^Changes (not staged|to be committed)/m.test(text) ||
    /^Untracked files:/m.test(text),
  apply: (text) =>
    lines(text)
      .filter((row) => !/^\s*\(use "/.test(row) && row.trim() !== '')
      .join('\n'),
};

/** `grep -n` — a bounded number of hits per file, with the rest counted. */
const grep: RtkFilter = {
  id: 'grep',
  detect: (text) => lines(text).filter((row) => /^[^\s:]+:\d+:/.test(row)).length >= 2,
  apply: (text) => {
    const perFile = new Map<string, number>();
    const kept: string[] = [];
    let dropped = 0;
    for (const row of lines(text)) {
      const match = /^([^\s:]+):(\d+):/.exec(row);
      if (match === null) {
        kept.push(row);
        continue;
      }
      const file = match[1] ?? '';
      const seen = perFile.get(file) ?? 0;
      perFile.set(file, seen + 1);
      if (seen < GREP_MATCHES_PER_FILE) kept.push(row);
      else dropped += 1;
    }
    if (dropped > 0) kept.push(`… ${dropped} matches omitted …`);
    return kept.join('\n');
  },
};

/** `find` — a bare path list, capped. */
const find: RtkFilter = {
  id: 'find',
  detect: (text) => {
    const rows = lines(text).filter((row) => row.trim() !== '');
    return (
      rows.length >= 3 &&
      rows.every((row) => /^[\w./@+-]+$/.test(row)) &&
      rows.some((row) => row.includes('/'))
    );
  },
  apply: (text) =>
    cap(
      lines(text).filter((row) => row.trim() !== ''),
      40,
      10,
    ).join('\n'),
};

/** A search-results list — identical rows carry nothing the first one did not. */
const searchList: RtkFilter = {
  id: 'searchList',
  detect: (text) => lines(text).some((row) => /\(\d+ matches?\)/.test(row)),
  apply: (text) => {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const row of lines(text)) {
      if (row.trim() === '' || seen.has(row)) continue;
      seen.add(row);
      kept.push(row);
    }
    return kept.join('\n');
  },
};

/** `tree` — the shape is the point, so only the depth is capped. */
const tree: RtkFilter = {
  id: 'tree',
  detect: (text) => /[├└]── /.test(text) || /^│/m.test(text),
  apply: (text) =>
    cap(
      lines(text).filter((row) => row.trim() !== ''),
      60,
      10,
    ).join('\n'),
};

/** `ls -l` — the `total` line and the blank separators carry nothing. */
const ls: RtkFilter = {
  id: 'ls',
  detect: (text) =>
    lines(text).filter((row) => /^[-dlbcps][rwxsStT-]{9}[@+.]?\s/.test(row)).length >= 2,
  apply: (text) =>
    lines(text)
      .filter((row) => !/^total \d+/.test(row) && row.trim() !== '')
      .join('\n'),
};

const BUILD_MARKER = /\b(error|warning)\b|TS\d{4}|BUILD FAILED|npm ERR!|✗|✖/i;

/** A compiler or bundler log — the diagnostics, not the progress chatter. */
const buildOutput: RtkFilter = {
  id: 'buildOutput',
  detect: (text) => /TS\d{4}|BUILD FAILED|npm ERR!|error:/.test(text),
  apply: (text) => {
    const kept = lines(text).filter((row) => BUILD_MARKER.test(row));
    return kept.length === 0 ? text : cap(kept, 60, 10).join('\n');
  },
};

/** A log where the same line repeats — the repeats become a count. */
const dedupLog: RtkFilter = {
  id: 'dedupLog',
  detect: (text) => {
    const rows = lines(text).filter((row) => row.trim() !== '');
    if (rows.length < 4) return false;
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1);
    return [...counts.values()].some((count) => count >= 3);
  },
  apply: (text) => {
    const rows = lines(text);
    const out: string[] = [];
    let index = 0;
    while (index < rows.length) {
      const row = rows[index] ?? '';
      let repeats = 1;
      while (index + repeats < rows.length && rows[index + repeats] === row) repeats += 1;
      out.push(repeats > 1 ? `${row}   (×${repeats})` : row);
      index += repeats;
    }
    return out.join('\n');
  },
};

/** A numbered file read — the gutter is ours, not the model's. */
const readNumbered: RtkFilter = {
  id: 'readNumbered',
  detect: (text) => lines(text).filter((row) => /^\s*\d+[\t→]/.test(row)).length >= 3,
  apply: (text) =>
    lines(text)
      .filter((row) => /^\s*\d+[\t→]/.test(row))
      .map((row) => row.replace(/^\s*\d+[\t→]\s?/, ''))
      .join('\n'),
};

/** A raw file dump with no recognisable shape — head and tail only. */
const cat: RtkFilter = {
  id: 'cat',
  detect: (text) => text.length > 4000 && lines(text).length > 60,
  apply: (text) => cap(lines(text), 120, 30).join('\n'),
};

/** The last resort, and the only filter that is off by default at every preset but aggressive. */
const smartTruncate: RtkFilter = {
  id: 'smartTruncate',
  detect: (text) => text.length > 2000,
  apply: (text) => cap(lines(text), 80, 20).join('\n'),
};

/**
 * In detection order, narrowest shape first.
 *
 * The order is load-bearing: a `git diff` also looks like a numbered read and a
 * long text, so the specific filters come before the generic ones or they would
 * never fire.
 */
export const RTK_FILTERS: readonly RtkFilter[] = [
  gitDiff,
  gitStatus,
  grep,
  find,
  searchList,
  tree,
  ls,
  buildOutput,
  dedupLog,
  readNumbered,
  cat,
  smartTruncate,
];
