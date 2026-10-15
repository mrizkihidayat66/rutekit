import type { Logger } from 'pino';
import type { ProviderManifest, ProviderRegistry } from '@registry';
import { applyAuth, endpointUrl, listingPath, withQuery } from '@registry';

import type { ProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';
import { readCredential } from '@server/providers/credential.ts';
import { retryAfterOf } from '@server/providers/dispatch-errors.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import type { ServerConfig } from '@server/runtime/config.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import { createOutcomeWriter, OUTCOME_TRANSIENT, outcomeFromStatus } from './outcome.ts';
import { readQuota } from './quota.ts';

/**
 * The warmup check-in (FR-3.5, FR-3.6).
 *
 * One authenticated round trip per account per interval, and it answers three
 * questions at once: is the credential still good, has the account's quota window
 * moved, and is a parked account fit to come back. That is why it is one probe
 * and not three timers — they are all the same question asked of the same
 * endpoint, and asking it three times would triple the traffic for no more
 * information.
 *
 * The round trip is a models listing, which is the cheapest authenticated GET
 * almost every provider in the catalogue has. It is not a chat turn: spending
 * tokens to prove a credential works is a cost an operator would rightly object
 * to, and a listing proves the same thing for free.
 *
 * A provider whose discovery is `static` has no listing to fetch, and is probed
 * at its base URL instead — for a local runner, "is it up" is exactly the
 * question. A provider that publishes no rate-limit headers is not a failure
 * either: the probe still proves the credential lives, and the quota columns are
 * left as a previous check-in set them.
 *
 * Nothing here throws. A probe that fails is data, not an exception — the caller
 * is a timer, and a rejection would only reach an unhandled-rejection handler
 * that can do nothing with it.
 */

export interface Warmup {
  /** Probe these providers' accounts, or every provider's when given nothing. */
  checkIn(providerIds?: readonly string[]): Promise<void>;
  /** Begin probing on the configured interval. */
  start(): void;
  stop(): void;
  /**
   * The providers being probed right now, so the console can say so (FR-3.6).
   *
   * A check-in is a network round trip per account and the page must not sit on a
   * spinner while it runs, so `POST /quota/check` starts one and answers at once:
   * this set is how the answer that follows knows to report `checking`.
   */
  checking(): ReadonlySet<string>;
  /** When the last check-in finished, or null before the first one. */
  lastCheckedAt(): string | null;
  /** Seconds until the next scheduled sweep, or null while none is scheduled. */
  nextSweepInSeconds(): number | null;
}

export interface WarmupDeps {
  readonly registry: ProviderRegistry;
  readonly accounts: ProviderAccountsRepository;
  readonly secrets: SecretBox | null;
  readonly fetch: ResponseFetcher;
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export function createWarmup(deps: WarmupDeps): Warmup {
  const now = deps.now ?? ((): Date => new Date());
  const writer = createOutcomeWriter({ accounts: deps.accounts, logger: deps.logger, now });
  let timer: ReturnType<typeof setInterval> | null = null;
  let nextSweepAtMs: number | null = null;
  let lastCheckAt: string | null = null;
  const inFlight = new Set<string>();
  /** One sweep at a time: a second one would probe the same accounts twice. */
  let running = false;

  /**
   * Bumped by `stop()`, so a sweep already in flight knows to stop going on.
   *
   * Clearing the interval is not enough on its own, and this is the whole reason
   * the counter exists. A check-in is a sequence of network round trips, and the
   * one running when the instance begins shutting down would otherwise carry on
   * reading the database after its caller has closed it — a
   * `RangeError: Cannot use a closed database`, thrown from a timer that nothing
   * is watching. Production has the same window as a test does: `warmup.stop()`
   * runs before `persistence.close()`, with the entire drain timeout in between.
   */
  let generation = 0;

  /** Whether the sweep that began this probe is still the current one. */
  function live(mine: number): boolean {
    return mine === generation;
  }

  /** The request to send, or null when this manifest and credential cannot reach anything. */
  function probeRequest(
    manifest: ProviderManifest,
    credential: string,
  ): { url: string; headers: Readonly<Record<string, string>> } | null {
    const target = endpointUrl(manifest, listingPath(manifest.discovery), {});
    // A templated base URL needs account fields rutekit has no column for yet;
    // the same gap the dispatcher reports, and probing it would only report it
    // again once per interval.
    if (target.missing.length > 0) return null;
    const auth = applyAuth(manifest, credential);
    const url =
      Object.keys(auth.query).length === 0 ? target.url : withQuery(target.url, auth.query);
    return { url, headers: auth.headers };
  }

  async function probeAccount(
    manifest: ProviderManifest,
    accountId: string,
    mine: number,
  ): Promise<void> {
    // Checked before every database touch rather than once at the top, because
    // the probe awaits a network round trip in the middle — and a `stop()` during
    // that await is precisely the case this exists for.
    if (!live(mine)) return;

    const row = deps.accounts.findById(accountId);
    if (row === null) return;

    const credential = readCredential(deps.secrets, row);
    if (credential === null) return;

    const request = probeRequest(manifest, credential.value);
    if (request === null) return;

    const at = now();

    let response: Response;
    try {
      response = await deps.fetch(request.url, {
        method: 'GET',
        headers: request.headers,
        signal: AbortSignal.timeout(deps.config.warmupTimeoutMs),
      });
    } catch (cause) {
      // Stopping is not an outcome, and it must not be recorded as one: the
      // probe never reached the provider, so writing `transient` here would
      // advance a failure streak for an account nothing is wrong with.
      if (!live(mine)) return;
      // Unreachable is transient: a host that is down says nothing about the
      // credential, so it advances the streak rather than parking anything.
      writer.apply(accountId, OUTCOME_TRANSIENT);
      deps.logger.debug({ accountId, err: cause }, 'warmup probe could not reach the provider');
      return;
    }

    // The body is not read: the status and the headers are the whole answer, and
    // an unconsumed body would hold a socket until it times out.
    void response.body?.cancel().catch(() => undefined);

    // The round trip is done and the answer is in hand, but the writes below go
    // to the database — so a stop that landed during the await still means
    // nothing more should be written.
    if (!live(mine)) return;

    if (response.ok) {
      const quota = readQuota(response.headers, at);
      if (quota !== null) {
        deps.accounts.setQuota(accountId, quota, at.toISOString());
      }
    }

    writer.apply(accountId, outcomeFromStatus(response.status, retryAfterOf(response.headers), at));
  }

  async function checkIn(providerIds?: readonly string[]): Promise<void> {
    // A manual check-in that lands while a sweep is running has nothing to add:
    // the sweep already covers every provider, so the second pass would only
    // double the traffic. The caller still sees `checking()` report its target.
    if (running) return;
    running = true;

    const mine = generation;
    const wanted = providerIds === undefined ? null : new Set(providerIds);
    const targets = deps.registry.all().filter((m) => wanted === null || wanted.has(m.id));
    for (const manifest of targets) inFlight.add(manifest.id);

    try {
      for (const manifest of targets) {
        if (!live(mine)) return;
        for (const row of deps.accounts.listByProvider(manifest.id)) {
          await probeAccount(manifest, row.id, mine);
        }
        // Dropped per provider rather than all at the end, so the console's
        // `checking` flag follows the sweep as it moves instead of sitting on
        // for the whole run.
        inFlight.delete(manifest.id);
      }
    } finally {
      running = false;
      inFlight.clear();
      // Not stamped when the sweep was cut short: the timestamp says "the
      // accounts were checked", and a stopped sweep did not check them.
      if (targets.length > 0 && live(mine)) lastCheckAt = now().toISOString();
    }
  }

  return {
    checkIn,

    start(): void {
      if (timer !== null) return;
      nextSweepAtMs = now().getTime() + deps.config.warmupIntervalMs;
      timer = setInterval(() => {
        nextSweepAtMs = now().getTime() + deps.config.warmupIntervalMs;
        void checkIn();
      }, deps.config.warmupIntervalMs);
      // A check-in must never be the reason the process stays alive.
      timer.unref();
    },

    stop(): void {
      // The generation is bumped even when no timer is running, because a manual
      // `checkIn()` may be mid-flight with no interval behind it at all.
      generation += 1;
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      nextSweepAtMs = null;
    },

    checking(): ReadonlySet<string> {
      return inFlight;
    },

    lastCheckedAt(): string | null {
      return lastCheckAt;
    },

    nextSweepInSeconds(): number | null {
      if (nextSweepAtMs === null) return null;
      return Math.max(0, Math.ceil((nextSweepAtMs - now().getTime()) / 1000));
    },
  };
}
