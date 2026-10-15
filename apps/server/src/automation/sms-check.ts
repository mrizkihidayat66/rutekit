import type { SmsProviderStatus } from '@contracts';

import type { ResponseFetcher } from '@server/providers/outbound.ts';

/**
 * Asking an activation service what a key is worth (C7a, FR-5.x).
 *
 * A `bulk-regist` job rents a number per attempt, so a key that has run out of
 * balance is the one fact that stops a batch — and an operator watching a
 * registration fail needs to know that before it fails, not after. So a check
 * reads the account behind the key and reports what it found.
 *
 * **The balance is the whole question.** 5sim answers `GET /v1/user/profile` with
 * the account's own view of itself: an id, an email, a balance and a rating.
 * Nothing here derives anything from those — the balance is passed through and
 * the currency is named, because a number an operator cannot attach a unit to is
 * a number they cannot act on.
 *
 * **A refusal is a status, not a throw.** A key that 401s, a service that 500s,
 * and a network that never answers all mean the same thing to the operator —
 * this key will not rent a number — so they collapse into `error` and the detail
 * goes to the log. Throwing would make the console's own route fail for one bad
 * key in a pool of ten, which is exactly the case the pool exists to survive.
 *
 * The call goes through the same egress guard every other outbound call does, so
 * the activation service is not a hole in the SSRF control (SEC-4).
 */

export interface SmsCheckResult {
  readonly status: SmsProviderStatus;
  readonly balance: number | null;
  readonly currency: string | null;
  /** Why it failed, for the log. Never shown to the client verbatim. */
  readonly error?: string;
}

export interface SmsChecker {
  check(kind: string, apiKey: string): Promise<SmsCheckResult>;
}

export interface SmsCheckerDeps {
  /**
   * The egress-checked fetcher the rest of the server uses.
   *
   * Injected rather than reached for as a global, so a test drives the check
   * without a network — and the guard is already inside it, so the activation
   * service is not a hole in the SSRF control (SEC-4).
   */
  readonly fetch: ResponseFetcher;
  readonly timeoutMs: number;
}

/** Where each service's account endpoint lives. One for now. */
const ENDPOINTS: Readonly<Record<string, { url: string; currency: string }>> = {
  '5sim': { url: 'https://5sim.net/v1/user/profile', currency: 'RUB' },
};

/** The unknown-kind verdict, so an unsupported `kind` is a failed check, not a crash. */
const UNSUPPORTED: SmsCheckResult = {
  status: 'error',
  balance: null,
  currency: null,
  error: 'unsupported activation service',
};

export function createSmsChecker(deps: SmsCheckerDeps): SmsChecker {
  return {
    async check(kind: string, apiKey: string): Promise<SmsCheckResult> {
      const endpoint = ENDPOINTS[kind];
      if (endpoint === undefined) return UNSUPPORTED;

      try {
        const response = await deps.fetch(endpoint.url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(deps.timeoutMs),
        });

        if (!response.ok) {
          // A 401 is the ordinary "this key is wrong or expired" and gets the
          // same verdict as any other refusal: the operator's next step is the
          // same either way.
          return {
            status: 'error',
            balance: null,
            currency: null,
            error: `the service answered HTTP ${String(response.status)}`,
          };
        }

        const balance = balanceOf(await response.json());
        if (balance === null) {
          // Answered, but not with anything this can read. Reporting `active`
          // with a null balance would claim the key works when the shape was
          // simply not understood.
          return {
            status: 'error',
            balance: null,
            currency: null,
            error: 'the service answered with an unrecognised body',
          };
        }

        return { status: 'active', balance, currency: endpoint.currency };
      } catch (cause) {
        return {
          status: 'error',
          balance: null,
          currency: null,
          error: describe(cause),
        };
      }
    },
  };
}

/**
 * The balance out of whatever the service said.
 *
 * Read structurally rather than through a schema: the field is one number in a
 * body rutekit does not otherwise care about, and a full schema would fail on the
 * next field the service adds. A negative balance is clamped to zero — 5sim
 * reports a debt as a negative number, and the contract's `nonnegative` is the
 * honest reading of "nothing left to spend".
 */
function balanceOf(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = (body as { balance?: unknown }).balance;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.max(0, raw);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the check failed';
}
