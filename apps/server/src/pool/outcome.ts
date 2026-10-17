import type { Logger } from 'pino';
import type { AccountState } from '@contracts';

import { isAppError } from '@server/errors.ts';
import type { ProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';

import { isAutomatic, parseAccountState } from './state-machine.ts';

/**
 * What an upstream answer means for the account it came from (FR-3.1, FR-3.3).
 *
 * Two callers ask this question and they must not answer it differently: the
 * pool, which sees the `AppError` a failed turn raised, and the warmup check-in,
 * which sees a bare HTTP status because it never gets far enough to raise one.
 * So the mapping lives here once and both read it.
 *
 * The mapping is a policy, not a lookup table, and the policy is: *the account is
 * only ever blamed for things the account can be blamed for.* A turn we addressed
 * wrongly, or one the client cancelled, says nothing about the credential — it is
 * `ignore`d, neither a recovery nor a mark against it. A 400 from a models probe
 * is the opposite: it means auth passed, so it is evidence the credential lives
 * and the account `recover`s. Only a refusal the provider aimed at the credential
 * parks the account, and only a repeated transient failure escalates.
 *
 * One asymmetry is worth naming, because it is a choice rather than an oversight.
 * A provider refusing a credential *mid-turn* arrives here as `upstream_error`:
 * `dispatch-errors.ts` deliberately keeps the client's status at 502, because a
 * `/v1` caller's own key is not what broke and a 401 would send them looking in
 * the wrong place. So the turn path can only say "this kept failing" and parks
 * the account in `error`; it is the probe, which sees the bare 401, that decides
 * `banned`. The two together converge — a dead credential reaches `banned` within
 * one check-in interval — without the data plane having to lie to its client.
 */

/** Turns in a row that make the streak itself the evidence an account is broken. */
export const FAILURE_THRESHOLD = 3;

/** How long an account rests when the provider was rate-limited but said no `Retry-After`. */
const DEFAULT_COOLDOWN_SECONDS = 60;

export type OutcomeEffect = 'recover' | 'ignore' | 'transient' | 'rest' | 'ban';

export interface Outcome {
  readonly effect: OutcomeEffect;
  readonly reason: string;
  /** The state to move to; null for the effects that move nothing. */
  readonly state: AccountState | null;
  readonly cooldownUntil: string | null;
}

const RECOVER: Outcome = { effect: 'recover', reason: '', state: 'active', cooldownUntil: null };
const IGNORE: Outcome = { effect: 'ignore', reason: '', state: null, cooldownUntil: null };

/** Exported for the probe, whose unreachable-host case is transient but is not an error. */
export const OUTCOME_TRANSIENT: Outcome = {
  effect: 'transient',
  reason: '',
  state: null,
  cooldownUntil: null,
};

function rest(
  state: 'rate_limited' | 'exhausted',
  reason: string,
  cooldownUntil: string | null,
): Outcome {
  return { effect: 'rest', reason, state, cooldownUntil };
}

function ban(reason: string): Outcome {
  return { effect: 'ban', reason, state: 'banned', cooldownUntil: null };
}

function inSeconds(at: Date, seconds: number): string {
  return new Date(at.getTime() + seconds * 1000).toISOString();
}

/** The failed turn's error, as an account outcome. */
export function outcomeFromError(error: unknown, at: Date): Outcome {
  const kind = isAppError(error) ? error.kind : null;
  const retryAfter = isAppError(error) ? error.retryAfterSeconds : null;

  // A provider that refused the credential is a `banned` account whichever path
  // noticed, and the manifest's own `errors` table is what said so. Checked before
  // the kind because the client-facing error for this is an `upstream_error` —
  // their key is not the problem — which would otherwise read as transient and
  // retry a dead account on every turn.
  if (isAppError(error) && error.credentialRefused) {
    return ban('The provider rejected this credential.');
  }

  switch (kind) {
    // We sent it wrong, or the client left. The turn is lost; the account is not
    // blamed for it, and there is nothing here that says it is healthy either.
    case 'invalid_request':
    case 'aborted':
    case 'not_found':
    case 'unavailable':
    case 'shutting_down':
      return IGNORE;

    case 'rate_limit':
      return rest(
        'rate_limited',
        'Rate limited by the provider.',
        inSeconds(at, retryAfter ?? DEFAULT_COOLDOWN_SECONDS),
      );

    // No clock of our own: the window belongs to the provider, and the check-in
    // is what notices it has reopened.
    case 'quota_exhausted':
      return rest('exhausted', 'Quota exhausted at the provider.', null);

    // The provider answered, and what it said was that this credential is no
    // good. Only an operator puts it back — that is what `banned` means.
    case 'authentication':
    case 'permission':
      return ban('The provider rejected this credential.');

    // A timeout, a 5xx, a bug: transient until it is not.
    case 'upstream_error':
    case 'timeout':
    case 'internal':
    case null:
      return OUTCOME_TRANSIENT;
  }
}

/**
 * A probe's HTTP status, as an account outcome.
 *
 * Anything that is not a refusal aimed at the credential counts as proof the
 * credential is alive: reaching a 400 or a 404 means auth was accepted and the
 * request itself was the problem. That reading is what lets an `error` account
 * come back — a probe that only ever `ignore`d would leave it parked for good.
 */
export function outcomeFromStatus(
  status: number,
  retryAfterSeconds: number | null,
  at: Date,
): Outcome {
  if (status === 401 || status === 403) return ban('The provider rejected this credential.');
  if (status === 402) return rest('exhausted', 'Quota exhausted at the provider.', null);
  if (status === 429) {
    return rest(
      'rate_limited',
      'Rate limited by the provider.',
      inSeconds(at, retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS),
    );
  }
  if (status >= 500) return OUTCOME_TRANSIENT;
  return RECOVER;
}

export interface OutcomeWriter {
  /** Record what happened to an account. Never throws, never touches a live turn. */
  apply(accountId: string, outcome: Outcome): void;
}

export interface OutcomeWriterDeps {
  readonly accounts: ProviderAccountsRepository;
  readonly logger: Logger;
  readonly now: () => Date;
}

/**
 * The one place an outcome becomes a write.
 *
 * Every move goes through `isAutomatic` first, so the table in `state-machine.ts`
 * stays the only statement of what the pool may do on its own: an account an
 * operator disabled is never brought back by a probe that happened to succeed,
 * and a `banned` account is never re-banned into a different reason.
 */
export function createOutcomeWriter(deps: OutcomeWriterDeps): OutcomeWriter {
  return {
    apply(accountId: string, outcome: Outcome): void {
      const row = deps.accounts.findById(accountId);
      if (row === null) return;
      const from = parseAccountState(row.state);
      if (from === null) return;

      const at = deps.now().toISOString();

      if (outcome.effect === 'ignore') return;

      if (outcome.effect === 'transient') {
        deps.accounts.recordFailure(accountId, at);
        const streak = row.consecutiveFailures + 1;
        if (streak < FAILURE_THRESHOLD) return;
        if (!isAutomatic(from, 'error')) return;
        deps.accounts.setState(
          accountId,
          'error',
          `Failed ${String(streak)} turns in a row.`,
          null,
          at,
        );
        deps.logger.warn({ accountId, from, streak }, 'account parked');
        return;
      }

      if (outcome.effect === 'recover') {
        // Clearing the streak even when the account is already `active` is the
        // point: one bad hour must not leave the next single failure sitting on
        // the edge of the threshold.
        deps.accounts.clearFailures(accountId, at);
        if (from === 'active' || !isAutomatic(from, 'active')) return;
        deps.accounts.setState(accountId, 'active', null, null, at);
        return;
      }

      const to = outcome.state;
      if (to === null || from === to || !isAutomatic(from, to)) return;
      deps.accounts.setState(accountId, to, outcome.reason, outcome.cooldownUntil, at);
      deps.logger.warn({ accountId, from, to }, 'account parked');
    },
  };
}
