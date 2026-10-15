import type {
  BulkResult,
  Proxy,
  ProxyCheckResult,
  ProxyHealth,
  ProxyInput,
  ProxyProtocol,
  ProxiesQuery,
  ProxiesResponse,
  ProxiesSummary,
  ProxyUpdate,
} from '@contracts';
import { proxyHealthSchema, proxyProtocolSchema } from '@contracts';
import type { Logger } from 'pino';

import { AppError } from '@server/errors.ts';
import type { ProxyRow, ProxiesRepository } from '@server/persistence/proxies.ts';
import { requireSecrets } from '@server/providers/oauth/resolve.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import { credentialOf, parseProxyLine, readCredential, type ParsedProxy } from './proxy-line.ts';
import type { ProxyProbe } from './proxy-probe.ts';

/**
 * The proxy pool (C7a, FR-5.x).
 *
 * A bulk import drives a browser somewhere, and where it goes from is a fact
 * about the batch rather than about the account: the same sign-in attempted from
 * one address a hundred times is the pattern a provider blocks. So a job pins an
 * egress from this pool, and the page is where an operator finds out which of the
 * egresses they bought still work.
 *
 * **The credential is write-only, and the read model says so honestly.** A proxy
 * URL carries `user:pass` in its authority, so a read model that echoed the row
 * would be a page that prints a paid residential password on screen. The contract
 * carries `hasAuth` — a boolean — and the password never leaves the box.
 *
 * **Health is only ever what a probe observed.** Nothing here infers a verdict
 * from the address, and nothing marks a proxy dead because a check timed out
 * once: `recordCheck` writes what happened, and the page shows it. That is the
 * difference between a health column an operator can act on and one they learn
 * to ignore.
 */

export interface ProxyService {
  list(query: ProxiesQuery): ProxiesResponse;
  get(id: string): Proxy;
  create(input: ProxyInput): Proxy;
  update(id: string, patch: ProxyUpdate): Proxy;
  remove(id: string): void;
  /** Bulk paste. Reports per line, since one bad row must not lose the rest. */
  importLines(payload: string): BulkResult;
  /** Probe these proxies, or the whole pool when the list is empty. */
  check(ids: readonly string[]): Promise<ProxyCheckResult>;
  summary(): ProxiesSummary;
}

export interface ProxyServiceDeps {
  readonly proxies: ProxiesRepository;
  readonly probe: ProxyProbe;
  readonly secrets: SecretBox | null;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** A stored row as the console's contract. Never carries the credential. */
export function toProxy(row: ProxyRow): Proxy {
  return {
    id: row.id,
    // A column written only from the contract's enum, so an unreadable one means
    // the row was edited outside rutekit. `http` is the safe reading: it is the
    // default a paste with no scheme gets, and it is the one that connects.
    protocol: (proxyProtocolSchema.safeParse(row.protocol).data ?? 'http') satisfies ProxyProtocol,
    host: row.host,
    port: row.port,
    hasAuth: row.credentialEnvelope !== null,
    health: (proxyHealthSchema.safeParse(row.health).data ?? 'untested') satisfies ProxyHealth,
    latencyMs: row.latencyMs,
    lastCheckedAt: row.lastCheckedAt,
    dispatchCount: row.dispatchCount,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SORTERS: Record<string, (row: ProxyRow) => string | number> = {
  host: (row) => row.host.toLowerCase(),
  protocol: (row) => row.protocol,
  health: (row) => row.health,
  latencyMs: (row) => row.latencyMs ?? Number.POSITIVE_INFINITY,
  lastCheckedAt: (row) => row.lastCheckedAt ?? '',
  dispatchCount: (row) => row.dispatchCount,
  createdAt: (row) => row.createdAt,
};

export function createProxyService(deps: ProxyServiceDeps): ProxyService {
  const now = deps.now ?? ((): Date => new Date());

  function require(id: string): ProxyRow {
    const row = deps.proxies.findById(id);
    if (row === null) throw AppError.notFound(`No proxy with id ${id}.`);
    return row;
  }

  /** The credential to connect with, decrypted. Null when the row carries none. */
  function credentialOfRow(id: string): string | null {
    const envelope = deps.proxies.credentialEnvelope(id);
    if (envelope === null) return null;
    // A row whose envelope will not decrypt is skipped rather than fatal — one
    // broken entry among several is not a reason to refuse the whole check.
    try {
      return requireSecrets(deps.secrets).decrypt(envelope);
    } catch {
      return null;
    }
  }

  function asParsed(row: ProxyRow): ParsedProxy | null {
    const raw = credentialOfRow(row.id);
    const credential = raw === null ? null : readCredential(raw);
    const protocol = proxyProtocolSchema.safeParse(row.protocol);
    return {
      protocol: protocol.success ? protocol.data : 'http',
      host: row.host,
      port: row.port,
      username: credential?.username ?? null,
      password: credential?.password ?? null,
    };
  }

  return {
    list(query: ProxiesQuery): ProxiesResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.proxies.listAll();

      if (query.protocol !== null) rows = rows.filter((row) => row.protocol === query.protocol);
      if (query.health !== null) rows = rows.filter((row) => row.health === query.health);
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.host, row.id, row.note].some(
            (value) => value !== null && value.toLowerCase().includes(needle),
          ),
        );
      }

      const sorted = sortRows(rows, query, (row) => row.id);
      const offset = offsetOf(query.cursor);
      return paginate(sorted.map(toProxy), offset, query.limit);
    },

    get(id: string): Proxy {
      return toProxy(require(id));
    },

    create(input: ProxyInput): Proxy {
      const at = now().toISOString();
      const credential =
        input.username === null && input.password === null
          ? null
          : JSON.stringify({ username: input.username ?? '', password: input.password ?? '' });

      return toProxy(
        deps.proxies.create({
          id: crypto.randomUUID(),
          protocol: input.protocol,
          host: input.host,
          port: input.port,
          credentialEnvelope:
            credential === null ? null : requireSecrets(deps.secrets).encrypt(credential),
          health: 'untested',
          latencyMs: null,
          lastCheckedAt: null,
          dispatchCount: 0,
          note: input.note,
          createdAt: at,
          updatedAt: at,
        }),
      );
    },

    update(id: string, patch: ProxyUpdate): Proxy {
      require(id);
      const at = now().toISOString();
      deps.proxies.update(
        id,
        {
          protocol: patch.protocol,
          host: patch.host,
          port: patch.port,
          note: patch.note,
        },
        at,
      );

      // Credentials are write-only, so a supplied pair is encrypted here and a
      // blank one is not a request to erase — the dialog sends empty fields when
      // the operator did not touch them. A pair that is present replaces both
      // halves, because a username with a stale password is not a thing anyone
      // means to save.
      if (patch.username !== undefined && patch.username !== null && patch.username !== '') {
        deps.proxies.setCredential(
          id,
          requireSecrets(deps.secrets).encrypt(
            JSON.stringify({ username: patch.username, password: patch.password ?? '' }),
          ),
          at,
        );
      }

      // Changing where a proxy points invalidates what was known about it: the
      // old verdict was about a different address, and carrying it over would
      // report a health nobody measured. The timestamp clears with it — a fresh
      // `lastCheckedAt` beside `untested` would show a check that never ran.
      if (patch.host !== undefined || patch.port !== undefined || patch.protocol !== undefined) {
        deps.proxies.recordCheck(id, { health: 'untested', latencyMs: null, checkedAt: null }, at);
      }

      return toProxy(require(id));
    },

    remove(id: string): void {
      require(id);
      deps.proxies.delete(id);
    },

    importLines(payload: string): BulkResult {
      // Indexed over the **original** split, blanks included, so a reported line
      // number is the one the operator can count to in their own paste. Filtering
      // first and numbering after would shift every number past the first blank —
      // pointing at the wrong line, which is worse than not pointing at all.
      const lines = payload.split('\n').map((line) => line.trim());
      const errors: { id: string; message: string }[] = [];
      let succeeded = 0;
      let requested = 0;

      lines.forEach((line, index) => {
        if (line === '') return;
        requested += 1;

        const parsed = parseProxyLine(line);
        if (!parsed.ok) {
          errors.push({ id: `line ${String(index + 1)}`, message: parsed.error });
          return;
        }

        try {
          const at = now().toISOString();
          const credential = credentialOf(parsed.proxy);
          deps.proxies.create({
            id: crypto.randomUUID(),
            protocol: parsed.proxy.protocol,
            host: parsed.proxy.host,
            port: parsed.proxy.port,
            credentialEnvelope:
              credential === null ? null : requireSecrets(deps.secrets).encrypt(credential),
            health: 'untested',
            latencyMs: null,
            lastCheckedAt: null,
            dispatchCount: 0,
            note: null,
            createdAt: at,
            updatedAt: at,
          });
          succeeded += 1;
        } catch (cause) {
          // One row's refusal is that row's problem: a paste of two hundred where
          // one line is a duplicate should still add the other hundred and ninety.
          errors.push({
            id: `line ${String(index + 1)}`,
            message: cause instanceof Error ? cause.message : 'the line could not be stored',
          });
        }
      });

      return { requested, succeeded, failed: errors.length, errors };
    },

    async check(ids: readonly string[]): Promise<ProxyCheckResult> {
      const targets =
        ids.length === 0 ? deps.proxies.listAll().map((row) => row.id) : [...ids];
      const results: ProxyCheckResult['results'] = [];

      // Sequential rather than concurrent: a pool of two hundred probed at once
      // would open two hundred sockets from one machine, which is the shape of a
      // flood — and the operator is watching the table fill in, not a benchmark.
      for (const id of targets) {
        const row = deps.proxies.findById(id);
        if (row === null) continue;
        const parsed = asParsed(row);
        if (parsed === null) {
          const at = now().toISOString();
          deps.proxies.recordCheck(id, { health: 'dead', latencyMs: null, checkedAt: at }, at);
          results.push({ id, health: 'dead', latencyMs: null });
          continue;
        }

        const result = await deps.probe.probe(parsed);
        if (result.error !== undefined) {
          deps.logger.debug({ proxyId: id, err: result.error }, 'proxy probe failed');
        }
        // Stamped *after* the probe rather than before the loop, because a probe
        // is a network round trip and a pool of fifty would otherwise report every
        // verdict as having been observed at the moment the check started.
        const at = now().toISOString();
        deps.proxies.recordCheck(
          id,
          { health: result.health, latencyMs: result.latencyMs, checkedAt: at },
          at,
        );
        results.push({ id, health: result.health, latencyMs: result.latencyMs });
      }

      return { results };
    },

    summary(): ProxiesSummary {
      const counts = { healthy: 0, slow: 0, dead: 0, untested: 0 };
      const rows = deps.proxies.listAll();
      for (const row of rows) {
        const health = proxyHealthSchema.safeParse(row.health).data ?? 'untested';
        counts[health] += 1;
      }
      return { total: rows.length, ...counts };
    },
  };
}

/**
 * Apply the query's sort, or leave the order alone when it named none.
 *
 * An unrecognised `sort` is left alone rather than refused, the same reading
 * `routing/list.ts` takes: the key travels as a bare field name, and a page that
 * has not been updated for a renamed column should show the natural order, not an
 * error. Ties break on the id so the order is total between pages.
 */
function sortRows(
  rows: readonly ProxyRow[],
  query: { sort: string | null; direction: 'asc' | 'desc' },
  idOf: (row: ProxyRow) => string,
): ProxyRow[] {
  const sorter = SORTERS[query.sort ?? ''];
  if (sorter === undefined) return [...rows];

  const direction = query.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sorter(a);
    const right = sorter(b);
    if (left === right) return idOf(a).localeCompare(idOf(b));
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return order * direction;
  });
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function paginate<TItem>(
  items: readonly TItem[],
  offset: number,
  limit: number,
): { items: TItem[]; nextCursor: string | null; total: number } {
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    nextCursor: next < items.length ? String(next) : null,
    total: items.length,
  };
}
