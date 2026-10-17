import { accountStateSchema, ROUTABLE_ACCOUNT_STATES, type AccountState } from '@contracts';

/**
 * The pool's state machine (FR-3.1, ADR-0020).
 *
 * Pure: no clock, no database, no network. It answers two questions and nothing
 * else — *may* this account move from one state to another, and may the pool do
 * it without an operator. Everything that decides *when* to move lives in
 * `pool.ts`, so the table below is the whole of the rule and can be read in one
 * sitting.
 *
 * The distinction between "may" and "may, automatically" is the load-bearing one.
 * A `disabled` account is manual-only by contract: an operator took it out, and
 * nothing the pool observes — not a success, not a quota reset, not a warmup —
 * puts it back. Encoding that as a separate set rather than as a comment is what
 * makes it a guarantee instead of an intention.
 */

/**
 * Every legal move. A state not listed for a source is a move that does not
 * exist, and `canTransition` refuses it rather than quietly allowing it.
 *
 * Read the two terminal-ish rows together: `banned` and `disabled` have no
 * outgoing move the pool may take. An operator clears them, which is why they
 * are also the only states `RECOVERABLE_ACCOUNT_STATES` in the contract names.
 */
const TRANSITIONS: Readonly<Record<AccountState, readonly AccountState[]>> = {
  // A new account proves itself by being used once, or fails its first use. A
  // probe that finds it out of quota is a third answer: the credential is good
  // and the account cannot serve yet, so it rests rather than being promoted.
  pending: ['active', 'exhausted', 'error', 'banned', 'disabled'],
  active: ['rate_limited', 'exhausted', 'error', 'banned', 'disabled'],
  rate_limited: ['active', 'exhausted', 'error', 'banned', 'disabled'],
  exhausted: ['active', 'rate_limited', 'error', 'banned', 'disabled'],
  error: ['active', 'rate_limited', 'exhausted', 'banned', 'disabled'],
  banned: ['active', 'disabled'],
  disabled: ['active', 'banned'],
};

/**
 * The moves the pool may make on its own. Anything legal but absent here needs
 * an operator: every move *into* `disabled`, and every move *out of* `banned` or
 * `disabled`. A provider telling rutekit an account is banned is the one signal
 * that arrives without a human, so `active → banned` is here.
 */
const AUTOMATIC: ReadonlySet<string> = new Set([
  'pending->active',
  'pending->exhausted',
  'pending->error',
  'pending->banned',
  'active->rate_limited',
  'active->exhausted',
  'active->error',
  'active->banned',
  'rate_limited->active',
  'rate_limited->exhausted',
  'rate_limited->error',
  'exhausted->active',
  'exhausted->rate_limited',
  'exhausted->error',
  'error->active',
  'error->rate_limited',
  'error->exhausted',
]);

/** True when a state may move to another at all. A state never moves to itself. */
export function canTransition(from: AccountState, to: AccountState): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

/** True when the pool may make this move without an operator asking for it. */
export function isAutomatic(from: AccountState, to: AccountState): boolean {
  return canTransition(from, to) && AUTOMATIC.has(`${from}->${to}`);
}

/**
 * The stored `state` column, narrowed.
 *
 * Null rather than a default when the text is not one of the seven: a row an
 * operator hand-edited into nonsense must not be silently read as `active` and
 * sent traffic, and it must not be silently rewritten either. The pool skips it,
 * which is the same treatment a state it cannot reason about deserves.
 */
export function parseAccountState(raw: string): AccountState | null {
  const parsed = accountStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Whether routing may select an account in this state (R5.4). */
export function isRoutable(state: AccountState): boolean {
  return ROUTABLE_ACCOUNT_STATES.includes(state);
}

/**
 * States that rest until a moment passes rather than until a human acts.
 * `rate_limited` waits out the provider's window; `exhausted` waits for the
 * quota to reset. The recovery sweep is what watches both clocks.
 */
export function isResting(state: AccountState): boolean {
  return state === 'rate_limited' || state === 'exhausted';
}
