import type {
  Account,
  AccountInput,
  AccountState,
  AccountUpdate,
  AccountsQuery,
  AccountsResponse,
  BulkAccountAction,
  BulkResult,
} from '@contracts';
import type { ProviderManifest, ProviderRegistry } from '@registry';

import { AppError, isAppError } from '@server/errors.ts';
import type {
  ProviderAccountPatch,
  ProviderAccountRow,
  ProviderAccountsRepository,
} from '@server/persistence/provider-accounts.ts';
import type { Pool } from '@server/pool/pool.ts';
import { canTransition, parseAccountState } from '@server/pool/state-machine.ts';
import { maskEmail } from '@server/providers/oauth/identity.ts';
import { requireSecrets } from '@server/providers/oauth/resolve.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

/**
 * The account pool's console surface (FR-3).
 *
 * Every read goes through `toAccount`, and `toAccount` takes the in-flight count
 * as an argument rather than reading the column. That is the C5 decision made
 * visible: the pool holds the live count in memory and the column is only its
 * mirror, so a list that read the column would show a figure that is one write
 * behind — or, after a hard kill, a figure that is simply wrong.
 *
 * The state machine is the other half. A manual move is checked against
 * `canTransition` rather than written straight through, because the table in
 * `state-machine.ts` is the single statement of which moves exist; a route that
 * skipped it could put an account somewhere the pool's own recovery would never
 * take it from. The automatic moves are the pool's, and they never come through
 * here.
 */

export interface AccountService {
  list(query: AccountsQuery): AccountsResponse;
  create(input: AccountInput): Account;
  update(id: string, patch: AccountUpdate): Account;
  remove(id: string): void;
  bulk(input: BulkAccountAction): BulkResult;
}

export interface AccountServiceDeps {
  readonly accounts: ProviderAccountsRepository;
  readonly registry: ProviderRegistry;
  readonly pool: Pool;
  readonly secrets: SecretBox | null;
  readonly now?: () => Date;
}

/** A comparable sort key: text for the labels, a number for the live count. */
type SortKey = string | number;

/** The state to paint a row as when its column holds something unrecognisable. */
const UNKNOWN_STATE: AccountState = 'disabled';

/** How a manual move explains itself when the operator supplied no reason. */
const ROTATE_REASON = 'Rotation requested. Sign in again to replace this credential.';

/**
 * The stored row as the console's contract.
 *
 * `state` falls back to `disabled` rather than throwing: the column is written
 * only by `setState` with a validated value, so an unreadable one means the row
 * was edited outside rutekit — and rendering that as the one state nothing routes
 * to is the safe reading, not a guess.
 */
export function toAccount(row: ProviderAccountRow, inFlight: number): Account {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    emailMasked: row.emailMasked,
    state: parseAccountState(row.state) ?? UNKNOWN_STATE,
    stateReason: row.stateReason,
    inFlight,
    maxInFlight: row.maxInFlight,
    cooldownUntil: row.cooldownUntil,
    quota: {
      windowSeconds: row.quotaWindowSeconds,
      limit: row.quotaLimit,
      remaining: row.quotaRemaining,
      resetAt: row.quotaResetAt,
      creditBalance: row.creditBalance,
      creditCurrency: row.creditCurrency,
    },
    consecutiveFailures: row.consecutiveFailures,
    lastUsedAt: row.lastUsedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The mode a hand-added credential is filed under: the provider's own key mode. */
function authModeFor(manifest: ProviderManifest | undefined): string {
  if (manifest === undefined) return 'api-key';
  const keyed = manifest.authModes.find((mode) => mode.mode === 'api-key');
  return (keyed ?? manifest.authModes[0])?.mode ?? 'api-key';
}

function matches(haystack: readonly (string | null)[], needle: string): boolean {
  return haystack.some((value) => value !== null && value.toLowerCase().includes(needle));
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function createAccountService(deps: AccountServiceDeps): AccountService {
  const now = deps.now ?? ((): Date => new Date());

  const lastUsed: (row: ProviderAccountRow) => SortKey = (row) => row.lastUsedAt ?? '';
  const sorters: Record<string, (row: ProviderAccountRow) => SortKey> = {
    label: (row) => row.label.toLowerCase(),
    state: (row) => row.state,
    inFlight: (row) => deps.pool.inFlight(row.id),
    lastUsedAt: lastUsed,
  };

  function requireRow(id: string): ProviderAccountRow {
    const row = deps.accounts.findById(id);
    if (row === null) throw AppError.notFound(`No account with id ${id}.`);
    return row;
  }

  function compare(left: SortKey, right: SortKey): number {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
  }

  /** The one write a manual state move makes, and the only gate before it. */
  function move(
    row: ProviderAccountRow,
    to: AccountState,
    reason: string | null,
    at: string,
  ): void {
    const from = parseAccountState(row.state);
    if (from === to) return;
    if (from !== null && !canTransition(from, to)) {
      throw AppError.invalidRequest(`An account in ${from} cannot be moved to ${to}.`);
    }
    deps.accounts.setState(row.id, to, reason, null, at);
  }

  /**
   * Put an account back in the rotation, and forget how it left.
   *
   * Clearing the streak is the point rather than a tidy-up: an account that left
   * `error` with three failures behind it would be parked again by the very next
   * one, which reads as the operator's click having done nothing.
   */
  function reenable(row: ProviderAccountRow, reason: string, at: string): void {
    move(row, 'active', reason, at);
    deps.accounts.clearFailures(row.id, at);
  }

  function applyBulk(
    row: ProviderAccountRow,
    action: BulkAccountAction['action'],
    note: string | null,
    at: string,
  ): void {
    switch (action) {
      case 'enable':
        reenable(row, 'Enabled by an operator.', at);
        return;
      case 'disable':
        move(row, 'disabled', note ?? 'Disabled by an operator.', at);
        return;
      case 'reset_cooldown':
        reenable(row, 'Cooldown cleared by an operator.', at);
        return;
      case 'reset_failures':
        // The streak only. The account is left where it is: an operator clearing
        // a backoff has not said the credential is good again.
        deps.accounts.clearFailures(row.id, at);
        return;
      case 'rotate':
        // No new secret travels with a bulk action, so this can only be the first
        // half of a rotation: the account leaves the rotation and waits for a
        // sign-in to replace what it holds. `disabled` is the state the table
        // reaches from every other one, and it is manual-only, so nothing brings
        // it back before a fresh credential is in place.
        move(row, 'disabled', ROTATE_REASON, at);
        return;
      case 'delete':
        deps.accounts.delete(row.id);
        return;
    }
  }

  return {
    list(query: AccountsQuery): AccountsResponse {
      const needle = query.q.trim().toLowerCase();

      let rows = deps.accounts.listAll();
      if (query.providerId !== null) {
        rows = rows.filter((row) => row.providerId === query.providerId);
      }
      if (query.state !== null) rows = rows.filter((row) => row.state === query.state);
      if (needle !== '') {
        rows = rows.filter((row) => matches([row.label, row.emailMasked, row.id, row.note], needle));
      }

      const sorter = sorters[query.sort ?? ''] ?? lastUsed;
      const direction = query.direction === 'asc' ? 1 : -1;
      const sorted = [...rows].sort((a, b) => {
        const order = compare(sorter(a), sorter(b));
        if (order === 0) return a.id.localeCompare(b.id);
        return order * direction;
      });

      const offset = offsetOf(query.cursor);
      const items = sorted
        .slice(offset, offset + query.limit)
        .map((row) => toAccount(row, deps.pool.inFlight(row.id)));
      const next = offset + query.limit;
      return {
        items,
        nextCursor: next < sorted.length ? String(next) : null,
        total: sorted.length,
      };
    },

    create(input: AccountInput): Account {
      const manifest = deps.registry.get(input.providerId);
      if (manifest === undefined) {
        throw AppError.invalidRequest(`No provider with id ${input.providerId}.`);
      }

      const at = now().toISOString();
      const row = deps.accounts.create({
        id: crypto.randomUUID(),
        providerId: input.providerId,
        label: input.label,
        credentialEnvelope: requireSecrets(deps.secrets).encrypt(input.credential),
        authMode: authModeFor(manifest),
        emailMasked: input.email === null ? null : maskEmail(input.email),
        // A key pasted by hand has never been used, so it starts `pending`: the
        // first turn or check-in is what proves it, and neither has happened.
        state: 'pending',
        stateReason: 'Awaiting first use.',
        maxInFlight: input.maxInFlight,
        note: input.note,
        createdAt: at,
        updatedAt: at,
      });
      return toAccount(row, 0);
    },

    update(id: string, patch: AccountUpdate): Account {
      const row = requireRow(id);
      const at = now().toISOString();

      const fields: ProviderAccountPatch = {
        label: patch.label,
        note: patch.note,
        maxInFlight: patch.maxInFlight,
      };
      deps.accounts.update(id, fields, at);

      if (patch.state !== undefined) {
        const from = parseAccountState(row.state);
        if (from !== patch.state) {
          move(row, patch.state, patch.stateReason ?? null, at);
        } else if (patch.stateReason !== undefined) {
          // A reason edited on its own keeps the cooldown it was parked with:
          // re-saving an account that is resting must not shorten its rest.
          deps.accounts.setState(id, from, patch.stateReason, row.cooldownUntil, at);
        }
        if (patch.state === 'active') deps.accounts.clearFailures(id, at);
      }

      // The credential is write-only, so a supplied one is encrypted here and a
      // blank one is not a request to erase: the drawer sends an empty field when
      // the operator did not touch it.
      const credential = patch.credential ?? null;
      if (credential !== null && credential !== '') {
        deps.accounts.setCredential(id, requireSecrets(deps.secrets).encrypt(credential), at);
      }

      return toAccount(requireRow(id), deps.pool.inFlight(id));
    },

    remove(id: string): void {
      requireRow(id);
      deps.accounts.delete(id);
    },

    bulk(input: BulkAccountAction): BulkResult {
      const at = now().toISOString();
      const errors: { id: string; message: string }[] = [];
      let succeeded = 0;

      for (const id of input.ids) {
        const row = deps.accounts.findById(id);
        if (row === null) {
          errors.push({ id, message: `No account with id ${id}.` });
          continue;
        }
        // One row's refusal is that row's problem: a paste of fifty where one id
        // is stale should still act on the other forty-nine.
        try {
          applyBulk(row, input.action, input.note, at);
          succeeded += 1;
        } catch (cause) {
          errors.push({
            id,
            message: isAppError(cause) ? cause.message : 'The action could not be applied.',
          });
        }
      }

      return { requested: input.ids.length, succeeded, failed: errors.length, errors };
    },
  };
}
