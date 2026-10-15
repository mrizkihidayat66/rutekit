import type {
  SmsProvider,
  SmsProviderCheckResult,
  SmsProviderInput,
  SmsProviderKind,
  SmsProviderStatus,
  SmsProviderUpdate,
  SmsProvidersQuery,
  SmsProvidersResponse,
  SmsProvidersSummary,
} from '@contracts';
import { smsProviderKindSchema, smsProviderStatusSchema } from '@contracts';
import type { Logger } from 'pino';

import { AppError } from '@server/errors.ts';
import type {
  SmsProviderRow,
  SmsProvidersRepository,
} from '@server/persistence/sms-providers.ts';
import { requireSecrets } from '@server/providers/oauth/resolve.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import type { SmsChecker } from './sms-check.ts';

/**
 * SMS activation keys (C7a, FR-5.x).
 *
 * A `bulk-regist` job creates accounts rather than signing them in, so each one
 * needs a number it can receive a single code on — and that number is rented per
 * attempt from one of these services. So this is a credential pool shaped exactly
 * like the proxy one, and the page is where an operator finds out which of the
 * keys they bought still have money on them.
 *
 * **The key is write-only and the read model says so.** `keyHint` is
 * `first4••••last4`, stored beside the envelope rather than derived from it: the
 * alternative would mean decrypting on every list, which is a read path that has
 * to hold the box for a value that never changes once set.
 *
 * **A disabled key stays disabled through a check.** A check reads the balance;
 * it does not overrule the person who switched the key off. That is the same rule
 * the account pool follows for a manually disabled account (ADR-0020), and for
 * the same reason: an operator's decision is not something an automatic reading
 * gets to reverse.
 */

export interface SmsProviderService {
  list(query: SmsProvidersQuery): SmsProvidersResponse;
  get(id: string): SmsProvider;
  create(input: SmsProviderInput): SmsProvider;
  update(id: string, patch: SmsProviderUpdate): SmsProvider;
  remove(id: string): void;
  /** Read the balance behind these keys, or every key when the list is empty. */
  check(ids: readonly string[]): Promise<SmsProviderCheckResult>;
  summary(): SmsProvidersSummary;
}

export interface SmsProviderServiceDeps {
  readonly providers: SmsProvidersRepository;
  readonly checker: SmsChecker;
  readonly secrets: SecretBox | null;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** A stored row as the console's contract. Never carries the key. */
export function toSmsProvider(row: SmsProviderRow): SmsProvider {
  return {
    id: row.id,
    kind: (smsProviderKindSchema.safeParse(row.kind).data ?? '5sim') satisfies SmsProviderKind,
    label: row.label,
    keyHint: row.keyHint,
    status: (smsProviderStatusSchema.safeParse(row.status).data ??
      'untested') satisfies SmsProviderStatus,
    balance: row.balance,
    currency: row.currency,
    country: row.country,
    operator: row.operator,
    product: row.product,
    successCount: row.successCount,
    failCount: row.failCount,
    lastCheckedAt: row.lastCheckedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A key as the operator should see it back.
 *
 * `first4••••last4` is the same convention the API-key panel uses, and it is a
 * hint rather than a disclosure: four characters of a forty-character key is not
 * enough to use and is enough to tell two keys apart in a list.
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

const SORTERS: Record<string, (row: SmsProviderRow) => string | number> = {
  label: (row) => row.label.toLowerCase(),
  status: (row) => row.status,
  balance: (row) => row.balance ?? Number.POSITIVE_INFINITY,
  lastCheckedAt: (row) => row.lastCheckedAt ?? '',
  createdAt: (row) => row.createdAt,
};

export function createSmsProviderService(deps: SmsProviderServiceDeps): SmsProviderService {
  const now = deps.now ?? ((): Date => new Date());

  function require(id: string): SmsProviderRow {
    const row = deps.providers.findById(id);
    if (row === null) throw AppError.notFound(`No SMS provider with id ${id}.`);
    return row;
  }

  /** The key to check with, decrypted. Null when the row carries none. */
  function keyOf(id: string): string | null {
    const envelope = deps.providers.credentialEnvelope(id);
    if (envelope === null) return null;
    try {
      return requireSecrets(deps.secrets).decrypt(envelope);
    } catch {
      // A row whose envelope will not decrypt is skipped rather than fatal — one
      // broken key among several is not a reason to refuse the whole check.
      return null;
    }
  }

  return {
    list(query: SmsProvidersQuery): SmsProvidersResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.providers.listAll();

      if (query.kind !== null) rows = rows.filter((row) => row.kind === query.kind);
      if (query.status !== null) rows = rows.filter((row) => row.status === query.status);
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.label, row.keyHint, row.note].some(
            (value) => value !== null && value.toLowerCase().includes(needle),
          ),
        );
      }

      const sorted = sortRows(rows, query);
      const offset = offsetOf(query.cursor);
      return paginate(sorted.map(toSmsProvider), offset, query.limit);
    },

    get(id: string): SmsProvider {
      return toSmsProvider(require(id));
    },

    create(input: SmsProviderInput): SmsProvider {
      const at = now().toISOString();
      return toSmsProvider(
        deps.providers.create({
          id: crypto.randomUUID(),
          kind: input.kind,
          label: input.label,
          credentialEnvelope: requireSecrets(deps.secrets).encrypt(input.apiKey),
          keyHint: maskKey(input.apiKey),
          // A key pasted by hand has never been used, so it starts `untested`: the
          // first check is what proves it, and that has not happened.
          status: 'untested',
          balance: null,
          currency: null,
          country: input.country,
          operator: input.operator,
          product: input.product,
          successCount: 0,
          failCount: 0,
          lastCheckedAt: null,
          note: input.note,
          createdAt: at,
          updatedAt: at,
        }),
      );
    },

    update(id: string, patch: SmsProviderUpdate): SmsProvider {
      require(id);
      const at = now().toISOString();
      deps.providers.update(
        id,
        {
          kind: patch.kind,
          label: patch.label,
          country: patch.country,
          operator: patch.operator,
          product: patch.product,
          note: patch.note,
        },
        at,
      );

      // A supplied key is a rotation: the envelope and the hint are written
      // together, so the masked value on screen can never describe a key that is
      // no longer the one stored. A blank field means the operator did not touch
      // it, and is not a request to erase.
      if (patch.apiKey !== undefined && patch.apiKey !== '') {
        deps.providers.setCredential(
          id,
          requireSecrets(deps.secrets).encrypt(patch.apiKey),
          maskKey(patch.apiKey),
          at,
        );
        // The old verdict was about a different key, so carrying it over would
        // report a balance nobody measured.
        deps.providers.recordCheck(id, { status: 'untested', balance: null, currency: null }, at);
      }

      return toSmsProvider(require(id));
    },

    remove(id: string): void {
      require(id);
      deps.providers.delete(id);
    },

    async check(ids: readonly string[]): Promise<SmsProviderCheckResult> {
      const targets = ids.length === 0 ? deps.providers.listAll().map((row) => row.id) : [...ids];
      const at = now().toISOString();
      const results: SmsProviderCheckResult['results'] = [];

      // Sequential, like the proxy probe and for the same reason: a check is a
      // round trip to a third party, and the operator is watching the table fill
      // in rather than measuring throughput.
      for (const id of targets) {
        const row = deps.providers.findById(id);
        if (row === null) continue;

        // A key the operator switched off is left alone. The check reads the
        // balance; it does not overrule the person who disabled it.
        if (row.status === 'disabled') {
          results.push({
            id,
            status: 'disabled',
            balance: row.balance,
            currency: row.currency,
          });
          continue;
        }

        const apiKey = keyOf(id);
        if (apiKey === null) {
          deps.providers.recordCheck(id, { status: 'error', balance: null, currency: null }, at);
          results.push({ id, status: 'error', balance: null, currency: null });
          continue;
        }

        const result = await deps.checker.check(row.kind, apiKey);
        if (result.error !== undefined) {
          deps.logger.debug({ smsProviderId: id, err: result.error }, 'SMS balance check failed');
        }
        deps.providers.recordCheck(
          id,
          { status: result.status, balance: result.balance, currency: result.currency },
          at,
        );
        results.push({
          id,
          status: result.status,
          balance: result.balance,
          currency: result.currency,
        });
      }

      return { results };
    },

    summary(): SmsProvidersSummary {
      const counts = { active: 0, disabled: 0, error: 0, untested: 0 };
      let successCount = 0;
      let failCount = 0;

      const rows = deps.providers.listAll();
      for (const row of rows) {
        const status = smsProviderStatusSchema.safeParse(row.status).data ?? 'untested';
        counts[status] += 1;
        successCount += row.successCount;
        failCount += row.failCount;
      }

      return { total: rows.length, ...counts, successCount, failCount };
    },
  };
}

/**
 * Apply the query's sort, or leave the order alone when it named none.
 *
 * `balance` sorts unpriced last in ascending order: a key that has never been
 * checked has no balance, and floating it to the top of "lowest balance" would
 * put the keys rutekit knows least about where an operator looks for trouble.
 */
function sortRows(
  rows: readonly SmsProviderRow[],
  query: { sort: string | null; direction: 'asc' | 'desc' },
): SmsProviderRow[] {
  const sorter = SORTERS[query.sort ?? ''];
  if (sorter === undefined) return [...rows];

  const direction = query.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sorter(a);
    const right = sorter(b);
    if (left === right) return a.id.localeCompare(b.id);
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
