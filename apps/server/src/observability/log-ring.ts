import type { LogEntry, LogKind, LogLevel, LogsQuery, LogsResponse } from '@contracts';

/**
 * The console log's buffer (C6, FR-12.1).
 *
 * A fixed-size ring in memory, fed by the same pino lines the process already
 * writes. **Deliberately not a table.** A log is diagnostic and high-volume — a
 * `debug` turn writes several lines, and a busy instance would put every one of
 * them through SQLite and then through a retention sweep of its own. The ring
 * costs a shift and a push, and the fact that it is empty after a restart is the
 * right behaviour for a tail: nobody reads yesterday's stdout out of a dashboard.
 *
 * It keeps the newest entries and drops the oldest, which is what makes a tail
 * useful — the interesting end of a log is the near one. `total` therefore counts
 * what the ring holds, not what the process has ever said, and the page's counts
 * are computed over the same set so the tabs always add up.
 *
 * Subscribers exist for the `logs` WebSocket channel. The console page polls, so
 * this is not what makes the page work — it is what makes a second client see the
 * same tail without a second poll.
 */

/** How many entries the ring holds. */
export const DEFAULT_LOG_CAPACITY = 2000;

/** The levels the console's tabs offer, worst first for the counts object. */
const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** pino's numeric levels, mapped onto the contract's four names. */
const LEVEL_NAMES: Readonly<Record<number, LogLevel>> = {
  10: 'debug',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'error',
};

export interface LogRing {
  /** Add one entry, evicting the oldest when full. */
  append(entry: LogEntry): void;
  /** One page, newest first, with the console's filters and level counts. */
  list(query: LogsQuery): LogsResponse;
  /** How many entries the ring is holding. */
  size(): number;
  /** Called for every appended entry. Returns an unsubscribe function. */
  subscribe(listener: (entry: LogEntry) => void): () => void;
  clear(): void;
}

/**
 * A pino line as the console's entry, or null when it is not one.
 *
 * `kind` is derived rather than logged, because it is a fact about the line's own
 * fields: a line carrying a status and a path came from a route, one carrying an
 * account id came from the pool, one carrying token counts came from the
 * dispatcher, and an error is an error whatever it is about. Deriving it here
 * means the logger does not have to remember to label every call site, and a new
 * call site lands in a sensible tab by default.
 */
export function entryFromLogLine(line: string): LogEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON: a stray `console.log`, or a line a dependency wrote. The console
    // log is rutekit's own output, so this is not an entry rather than a guess.
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const time = typeof record['time'] === 'string' ? record['time'] : null;
  const message = typeof record['msg'] === 'string' ? record['msg'] : null;
  if (time === null || message === null) return null;

  const level = LEVEL_NAMES[typeof record['level'] === 'number' ? record['level'] : 30] ?? 'info';
  const requestId = typeof record['requestId'] === 'string' ? record['requestId'] : null;
  const providerId = typeof record['providerId'] === 'string' ? record['providerId'] : null;
  const accountId = typeof record['accountId'] === 'string' ? record['accountId'] : null;

  return {
    id: crypto.randomUUID(),
    at: time,
    level,
    kind: kindOf(record, level),
    message,
    requestId,
    providerId,
    accountId,
    fields: fieldsOf(record),
  };
}

/** The reserved keys pino writes, which are not "fields" the console shows. */
const RESERVED = new Set([
  'level',
  'time',
  'msg',
  'pid',
  'hostname',
  'requestId',
  'providerId',
  'accountId',
]);

function kindOf(record: Record<string, unknown>, level: LogLevel): LogKind {
  if (level === 'error') return 'error';
  if (accountIdOf(record) !== null) return 'account';
  if (typeof record['path'] === 'string' || typeof record['method'] === 'string') return 'route';
  if ('inputTokens' in record || 'outputTokens' in record || 'model' in record) return 'token';
  return 'system';
}

function accountIdOf(record: Record<string, unknown>): string | null {
  return typeof record['accountId'] === 'string' ? record['accountId'] : null;
}

/**
 * Everything else on the line, as strings.
 *
 * The contract carries `Record<string, string>`, so a nested object or a number
 * is stringified here rather than dropped — the panel shows the shape of the
 * line, and losing a field because it was not already a string would make the
 * log less useful than the stdout it came from.
 */
function fieldsOf(record: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED.has(key) || value === undefined) continue;
    fields[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return fields;
}

/** An entry and the order it arrived in, which is the only total order there is. */
interface Slot {
  readonly entry: LogEntry;
  readonly seq: number;
}

export function createLogRing(capacity: number = DEFAULT_LOG_CAPACITY): LogRing {
  const entries: Slot[] = [];
  const listeners = new Set<(entry: LogEntry) => void>();
  let seq = 0;

  return {
    append(entry: LogEntry): void {
      seq += 1;
      entries.push({ entry, seq });
      // One shift per entry once full, which is the whole cost of the ring.
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
      for (const listener of listeners) listener(entry);
    },

    list(query: LogsQuery): LogsResponse {
      const needle = query.q.trim().toLowerCase();

      // Narrowed by everything except the level, and the counts are taken here.
      // That is what makes the tabs answerable: "how many warnings are there"
      // has to mean the same number whichever tab is selected, and a count that
      // moved when the level changed could not.
      let rows = [...entries];
      if (query.kind !== null) rows = rows.filter((slot) => slot.entry.kind === query.kind);
      if (query.requestId !== null) {
        rows = rows.filter((slot) => slot.entry.requestId === query.requestId);
      }
      if (needle !== '') {
        rows = rows.filter(
          (slot) =>
            slot.entry.message.toLowerCase().includes(needle) ||
            Object.values(slot.entry.fields).some((value) =>
              value.toLowerCase().includes(needle),
            ),
        );
      }
      const counts = countsOf(rows.map((slot) => slot.entry));

      if (query.level !== null) rows = rows.filter((slot) => slot.entry.level === query.level);

      const sorted = sortLogs(rows, query);
      const offset = offsetOf(query.cursor);
      const page = sorted.slice(offset, offset + query.limit);
      const next = offset + query.limit;
      return {
        items: page.map((slot) => slot.entry),
        nextCursor: next < sorted.length ? String(next) : null,
        total: sorted.length,
        counts,
      };
    },

    size(): number {
      return entries.length;
    },

    subscribe(listener: (entry: LogEntry) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    clear(): void {
      entries.length = 0;
    },
  };
}

function countsOf(rows: readonly LogEntry[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const entry of rows) counts[entry.level] += 1;
  return counts;
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Newest first by default, because a tail is read from the bottom.
 *
 * The tie-break is the arrival order, not the timestamp. Two lines written in the
 * same millisecond — which a single request produces routinely — would otherwise
 * sort arbitrarily, and a tail that showed them in the wrong order would be
 * showing a sequence that never happened.
 *
 * `sort` names a field the console offers; an unrecognised one falls back to the
 * natural order rather than refusing, the same reading `routing/list.ts` takes.
 */
function sortLogs(rows: readonly Slot[], query: LogsQuery): Slot[] {
  const direction = query.direction === 'asc' ? 1 : -1;
  const sorted = [...rows];

  if (query.sort === 'level') {
    // Worst first when descending, so `?sort=level` puts errors at the top.
    const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    sorted.sort(
      (a, b) =>
        (rank[a.entry.level] - rank[b.entry.level]) * direction || (a.seq - b.seq) * direction,
    );
    return sorted;
  }

  // Every other key is the timestamp: it is the only other column worth ordering.
  sorted.sort((a, b) => {
    const order = a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : 0;
    return order * direction || (a.seq - b.seq) * direction;
  });
  return sorted;
}

/** The level names, so a caller does not re-declare the console's tabs. */
export { LEVELS as LOG_LEVELS };
