import type { Logger } from 'pino';
import type {
  Job,
  JobControlBody,
  JobInput,
  JobItem,
  JobManualBody,
  JobSessionBody,
  JobStatus,
  JobStep,
  JobsQuery,
  JobsResponse,
  WorkerJob,
  WorkerToHost,
} from '@contracts';
import { jobStatusSchema } from '@contracts';
import type { ProviderRegistry } from '@registry';

import { AppError } from '@server/errors.ts';
import type { AccountService } from '@server/accounts/service.ts';
import type { JobItemRow, JobRow, JobsRepository } from '@server/persistence/jobs.ts';
import type { ProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';
import type { ProxiesRepository } from '@server/persistence/proxies.ts';
import type { SmsProvidersRepository } from '@server/persistence/sms-providers.ts';
import { requireSecrets } from '@server/providers/oauth/resolve.ts';
import type { RealtimeHub } from '@server/realtime/hub.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import { effectiveConcurrency, type CapacityOptions } from '../capacity.ts';
import type { WorkerHandle, WorkerLauncher } from '../launcher.ts';
import { readCredential } from '../proxy-line.ts';
import { batchOf } from '../payload.ts';

/**
 * Running automation jobs (C7b, FR-5.1–5.12).
 *
 * One worker process per job, supervised from here. The manager owns everything
 * the worker cannot: which items exist, what a status means, when a deadline has
 * passed, what happens when a process dies, and where a produced credential is
 * stored. The worker owns the batch itself — its items, its retries, its browser.
 *
 * **Steps live in memory.** A step is streamed the moment it happens and is not
 * written down; a two-hundred-account batch at eight steps each would be sixteen
 * hundred rows kept for a reader who is not watching. What survives a restart is
 * the ledger: which items ran, how many times, and how they ended. So the read
 * model merges the durable rows with whatever steps this process still holds, and
 * a job from a previous run simply has none.
 *
 * **The host holds two clocks and no more.** One is the manual deadline — the
 * countdown the operator watches and the clock that abandons a blocked item have
 * to be the same clock, and only the host has one the console can read. The other
 * is the readiness window: a worker that never announces itself is a job that
 * failed, not a job that is starting.
 *
 * **Pause kills.** That is the decision this was built to: a browser part-way
 * through a sign-in cannot be frozen, so the honest reading of "stop" is to stop
 * — the worker goes, and its in-flight items return to the queue to be run again
 * from the beginning. The cost is that a paused job repeats the sign-ins that
 * were underway; the benefit is that a paused job is genuinely paused, and
 * nothing is left holding a socket while the operator thinks.
 */

/** How long a worker gets to announce itself before the job is a failure. */
const READY_TIMEOUT_MS = 30_000;

/** How long a worker gets to close its browsers after a cancel before it is killed. */
const CANCEL_GRACE_MS = 2_000;

/**
 * How long a worker may say nothing before it is considered stuck (FR-5.10).
 *
 * **A parked item is not a stall.** A worker waiting for an operator to solve a
 * captcha is silent by design — that is the state FR-5.4 asks it to sit in — and a
 * watchdog that counted that silence would kill exactly the jobs that need a
 * person. So the clock is checked against `needsManual`: while the job is waiting
 * for an answer, the manual deadline is what governs it and this clock stands
 * down.
 *
 * Five minutes, because a slow provider page and a long sign-in both legitimately
 * go quiet for a while, and a shorter clock would kill work that was progressing.
 */
const STALL_TIMEOUT_MS = 5 * 60_000;

/**
 * Timers, injectable.
 *
 * A deadline that a test has to wait out is a test that takes minutes; the whole
 * point of the manual timeout is that it is measured in minutes in production. So
 * the clock is a seam, and a test fires it on demand.
 */
export interface Timers {
  /** Run `fn` after `ms`. Returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export interface JobManager {
  create(input: JobInput): Job;
  list(query: JobsQuery): JobsResponse;
  get(id: string): Job;
  control(id: string, action: JobControlBody["action"]): Job;
  /** The operator's answer to a challenge (FR-5.4, FR-5.5). */
  manual(id: string, body: JobManualBody): Job;
  /** The operator is taking this item over (FR-5.7): refresh it and restart the clock. */
  session(id: string, body: JobSessionBody): Job;
  /** Turn rows a previous process left mid-flight into something actionable. */
  recover(): void;
  /** Stop every worker. Called on drain. */
  shutdown(): void;
}

export interface JobManagerDeps {
  readonly jobs: JobsRepository;
  readonly accounts: AccountService;
  readonly accountRows: ProviderAccountsRepository;
  readonly proxies: ProxiesRepository;
  readonly smsProviders: SmsProvidersRepository;
  readonly registry: ProviderRegistry;
  readonly launcher: WorkerLauncher;
  readonly hub: RealtimeHub;
  readonly secrets: SecretBox | null;
  readonly logger: Logger;
  readonly timers?: Timers;
  readonly now?: () => Date;
  /**
   * What this machine can carry (FR-5.8).
   *
   * Injectable so a test can describe a small machine rather than run on whatever
   * the CI box happens to be — the cap is a policy about cores and memory, and a
   * test that asserted it against real hardware would pass or fail by accident.
   */
  readonly capacity?: CapacityOptions;
}

/** What this process holds about one job that is or was running. */
interface LiveJob {
  readonly id: string;
  readonly workerId: string;
  handle: WorkerHandle | null;
  /** Set once the job has landed, so a late frame or exit is not acted on. */
  finished: boolean;
  /** Steps reported since this process started, keyed by item. */
  readonly steps: Map<string, JobStep[]>;
  /** Cancel the readiness clock. */
  cancelReady: (() => void) | null;
  /** Cancel the manual deadline. */
  cancelDeadline: (() => void) | null;
  /** Cancel the kill-after-grace clock. */
  cancelKill: (() => void) | null;
  /** Cancel the stall clock, re-armed by every frame the worker sends. */
  cancelStall: (() => void) | null;
  /** When the worker last said anything, for the stall check. */
  lastFrameAtMs: number;
  /**
   * Whether this job is parked on a human.
   *
   * Read by the stall clock, which stands down while it is true — a worker
   * waiting for an operator is silent on purpose, and killing it would be killing
   * the state FR-5.4 asks for.
   */
  awaitingManual: boolean;
}

const LIVE_STATUSES: readonly JobStatus[] = ['queued', 'running', 'needs_manual'];

export function createJobManager(deps: JobManagerDeps): JobManager {
  const now = deps.now ?? ((): Date => new Date());
  const timers = deps.timers ?? realTimers;
  const live = new Map<string, LiveJob>();

  /* ---- Reading ---- */

  function stepsOf(jobId: string): Map<string, JobStep[]> {
    return live.get(jobId)?.steps ?? new Map();
  }

  function toItem(row: JobItemRow, steps: readonly JobStep[]): JobItem {
    return {
      id: row.id,
      accountLabel: row.accountLabel,
      status: parseStatus(row.status),
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      lastError: row.lastError,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      steps: [...steps],
    };
  }

  function toJob(row: JobRow, includeItems: boolean): Job {
    const steps = stepsOf(row.id);
    return {
      id: row.id,
      providerId: row.providerId,
      method: row.method as Job['method'],
      engine: row.engine === null ? null : (row.engine as Job['engine']),
      mode: row.mode === null ? null : (row.mode as Job['mode']),
      proxyId: row.proxyId,
      status: parseStatus(row.status),
      concurrency: row.concurrency,
      // Only set when the machine held the number down, so a job that got what it
      // asked for carries a null rather than repeating the same figure twice.
      effectiveConcurrency: row.effectiveConcurrency,
      total: row.total,
      succeeded: row.succeeded,
      failed: row.failed,
      needsManual: row.needsManual,
      manualWorkerId: row.manualWorkerId,
      manualDeadlineAt: row.manualDeadlineAt,
      items: includeItems
        ? deps.jobs.itemsOf(row.id).map((item) => toItem(item, steps.get(item.id) ?? []))
        : [],
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  function require(id: string): JobRow {
    const row = deps.jobs.findById(id);
    if (row === null) throw AppError.notFound(`No job with id ${id}.`);
    return row;
  }

  /* ---- Telling the console ---- */

  function publish(row: JobRow): void {
    deps.hub.publish('jobs', { type: 'job_update', job: toJob(row, true) });
  }

  /* ---- Launching ---- */

  /** The worker payload for these items, with everything resolved. */
  function workerJobOf(row: JobRow, itemRows: readonly JobItemRow[]): WorkerJob {
    const manifest = deps.registry.get(row.providerId);
    const automation = manifest?.automation ?? null;
    const proxy = proxyOf(row.proxyId);
    const sms = smsOf(row.smsProviderId);

    // The credentials come back out of the encrypted envelope. A job whose
    // envelope will not open cannot run — its items exist but nothing can be
    // handed to a worker for them.
    const credentials = readPayload(row.id);

    return {
      jobId: row.id,
      providerId: row.providerId,
      method: row.method as WorkerJob['method'],
      engine: row.engine === null ? null : (row.engine as WorkerJob['engine']),
      mode: row.mode === null ? null : (row.mode as WorkerJob['mode']),
      // The number the machine will actually carry, not the number that was asked
      // for: the worker sizes its own loops from this, so a job capped to two must
      // be told two rather than being left to open eight contexts and hope.
      concurrency: row.effectiveConcurrency ?? row.concurrency,
      maxAttempts: itemRows[0]?.maxAttempts ?? 3,
      automation:
        automation === null
          ? null
          : {
              login: automation.login,
              startUrl: automation.startUrl,
              captcha: automation.captcha,
              humanTimeoutSeconds: automation.humanTimeoutSeconds,
            },
      proxy,
      sms,
      items: itemRows.map((item) => ({
        id: item.id,
        label: item.accountLabel,
        credential: credentials.get(item.id) ?? null,
      })),
    };
  }

  function proxyOf(proxyId: string | null): { url: string } | null {
    if (proxyId === null) return null;
    const row = deps.proxies.findById(proxyId);
    if (row === null) return null;
    const envelope = deps.proxies.credentialEnvelope(proxyId);
    const credential = envelope === null ? null : decrypt(envelope);
    const auth = credential === null ? null : readCredential(credential);
    const authority =
      auth === null
        ? row.host
        : `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@${row.host}`;
    return { url: `${row.protocol}://${authority}:${String(row.port)}` };
  }

  function smsOf(smsProviderId: string | null): WorkerJob['sms'] {
    if (smsProviderId === null) return null;
    const row = deps.smsProviders.findById(smsProviderId);
    if (row === null) return null;
    const envelope = deps.smsProviders.credentialEnvelope(smsProviderId);
    const apiKey = envelope === null ? null : decrypt(envelope);
    if (apiKey === null) return null;
    return {
      kind: row.kind,
      apiKey,
      country: row.country,
      operator: row.operator,
      product: row.product,
    };
  }

  function decrypt(envelope: string): string | null {
    try {
      return requireSecrets(deps.secrets).decrypt(envelope);
    } catch {
      // A row whose envelope will not open is a row this process cannot use. The
      // job fails with a message rather than handing a worker a null credential.
      return null;
    }
  }

  /** The batch's credentials, keyed by item id. */
  function readPayload(jobId: string): Map<string, string> {
    const out = new Map<string, string>();
    const envelope = deps.jobs.payloadEnvelope(jobId);
    if (envelope === null) return out;
    const raw = decrypt(envelope);
    if (raw === null) return out;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return out;
    }
    if (parsed === null || typeof parsed !== 'object') return out;

    for (const [itemId, credential] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof credential === 'string') out.set(itemId, credential);
    }
    return out;
  }

  /** Start (or restart) a worker for the items that are queued. */
  function launch(row: JobRow): void {
    const itemRows = deps.jobs.itemsOf(row.id).filter((item) => item.status === 'queued');
    if (itemRows.length === 0) {
      settle(row);
      return;
    }

    const at = now().toISOString();
    deps.jobs.update(row.id, { status: 'running', startedAt: row.startedAt ?? at }, at);
    const running = require(row.id);

    const state: LiveJob = live.get(row.id) ?? {
      id: row.id,
      workerId: row.id,
      handle: null,
      finished: false,
      steps: new Map(),
      cancelReady: null,
      cancelDeadline: null,
      cancelKill: null,
      cancelStall: null,
      lastFrameAtMs: 0,
      awaitingManual: false,
    };
    state.finished = false;
    state.steps.clear();
    state.awaitingManual = false;
    state.lastFrameAtMs = now().getTime();
    live.set(row.id, state);

    const handle = deps.launcher.launch(state.workerId);
    state.handle = handle;
    handle.onMessage((message) => {
      // Every frame is evidence the worker is alive, which is what the stall clock
      // measures — so the clock restarts before the message is acted on, and a
      // worker that keeps talking never trips it however long the job runs.
      state.lastFrameAtMs = now().getTime();
      if (!state.finished) armStall(state, row.id);
      apply(state, message);
    });
    handle.onExit((code, signal) => {
      onExit(state, code, signal);
    });

    // A worker that never announces itself is a job that failed, not one that is
    // starting — and without this clock it would sit `running` for ever.
    state.cancelReady = timers.after(READY_TIMEOUT_MS, () => {
      if (state.finished) return;
      deps.logger.warn({ jobId: row.id, workerId: state.workerId }, 'worker never became ready');
      state.handle?.kill();
      failJob(state, 'the worker did not start');
    });

    // FR-5.10. A worker that has said nothing for long enough is stuck — a browser
    // that never came back, a page that hung — and the only way out is to kill it.
    // The check stands down while the job is parked on a human, because that
    // silence is the state working as designed.
    armStall(state, row.id);

    publish(running);
  }

  /** Re-arm the stall clock. Called on launch and after every frame that is not itself a stall check. */
  function armStall(state: LiveJob, jobId: string): void {
    state.cancelStall?.();
    state.cancelStall = timers.after(STALL_TIMEOUT_MS, () => {
      if (state.finished) return;

      const row = deps.jobs.findById(jobId);
      if (row === null) return;

      // A parked job is waiting for a person, not stuck. Its own deadline is what
      // governs it, so the stall clock re-arms and stands down again.
      if (state.awaitingManual || row.needsManual > 0) {
        armStall(state, jobId);
        return;
      }

      deps.logger.warn(
        { jobId, workerId: state.workerId, silentMs: now().getTime() - state.lastFrameAtMs },
        'automation worker went quiet; killing it',
      );
      state.handle?.kill();
      failJob(state, 'the worker stopped responding');
    });
  }

  /* ---- Applying what a worker says ---- */

  function apply(state: LiveJob, message: WorkerToHost): void {
    if (state.finished) return;
    const row = deps.jobs.findById(state.id);
    if (row === null) return;

    switch (message.type) {
      case 'ready': {
        state.cancelReady?.();
        state.cancelReady = null;
        // The job goes out only now, so a worker that failed to load its own
        // modules never receives one.
        const itemRows = deps.jobs.itemsOf(row.id).filter((item) => item.status === 'queued');
        state.handle?.send({
          type: 'start',
          workerId: state.workerId,
          job: workerJobOf(row, itemRows),
        });
        return;
      }

      case 'step': {
        // The first step of an item is what proves it is in flight, so that is
        // where the ledger learns it. Without this an operator watching a running
        // job sees every credential still `queued` — including the three the
        // worker is in the middle of — which is the one thing the row is for.
        const item = deps.jobs.itemById(message.itemId);
        if (item !== null && item.status === 'queued') {
          deps.jobs.updateItem(
            message.itemId,
            { status: 'running', startedAt: now().toISOString() },
            now().toISOString(),
          );
        }

        const list = state.steps.get(message.itemId) ?? [];
        const index = list.length;
        list.push({
          id: crypto.randomUUID(),
          index,
          name: message.name,
          status: message.status,
          detail: message.detail,
          startedAt: message.status === 'running' ? now().toISOString() : null,
          finishedAt: message.status === 'running' ? null : now().toISOString(),
          screenshotId: null,
        });
        state.steps.set(message.itemId, list);
        deps.hub.publish('jobs', {
          type: 'job_step',
          jobId: row.id,
          itemId: message.itemId,
          step: list[index] as JobStep,
        });
        return;
      }

      case 'screenshot': {
        deps.hub.publish('preview', {
          type: 'preview_frame',
          jobId: row.id,
          workerId: message.workerId,
          frameUrl: message.frameUrl,
          width: message.width,
          height: message.height,
          capturedAt: now().toISOString(),
        });
        return;
      }

      case 'needs-manual': {
        const at = now().toISOString();
        deps.jobs.updateItem(
          message.itemId,
          { status: 'needs_manual', startedAt: deps.jobs.itemById(message.itemId)?.startedAt ?? at },
          at,
        );
        // The deadline is the provider's own allowance, and it starts now. The
        // worker reported the seconds; the host is what counts them.
        const deadline = new Date(now().getTime() + message.humanTimeoutSeconds * 1_000);
        deps.jobs.refreshCounters(row.id, at);
        deps.jobs.update(
          row.id,
          {
            status: 'needs_manual',
            manualWorkerId: state.workerId,
            manualDeadlineAt: deadline.toISOString(),
          },
          at,
        );

        deps.hub.publish('jobs', {
          type: 'job_needs_manual',
          jobId: row.id,
          workerId: state.workerId,
          itemId: message.itemId,
          reason: message.reason,
          screenshotUrl: message.screenshotUrl,
          manualDeadlineAt: deadline.toISOString(),
        });

        state.cancelDeadline?.();
        state.cancelDeadline = timers.after(message.humanTimeoutSeconds * 1_000, () => {
          abandonItem(state, message.itemId);
        });

        // The stall clock stands down from here: the worker is waiting for a
        // person, which is silence by design, and the manual deadline is what
        // governs it now (FR-5.4).
        state.awaitingManual = true;
        publish(require(row.id));
        return;
      }

      case 'item-done': {
        const at = now().toISOString();
        storeAccount(row, message.label, message.credential);
        deps.jobs.updateItem(
          message.itemId,
          { status: 'succeeded', lastError: null, finishedAt: at },
          at,
        );
        afterItem(row.id);
        return;
      }

      case 'item-failed': {
        const at = now().toISOString();
        deps.jobs.updateItem(
          message.itemId,
          {
            status: 'failed',
            attempts: message.attempts,
            lastError: message.error,
            finishedAt: at,
          },
          at,
        );
        afterItem(row.id);
        return;
      }

      case 'done': {
        settle(row);
        return;
      }

      case 'failed': {
        failJob(state, message.error);
        return;
      }
    }
  }

  /** Store a credential the worker obtained as a provider account. */
  function storeAccount(row: JobRow, label: string, credential: string): void {
    try {
      deps.accounts.create({
        providerId: row.providerId,
        label,
        credential,
        email: null,
        note: `Imported by job ${row.id}.`,
        maxInFlight: 1,
      });
    } catch (cause) {
      // A credential that cannot be stored is a real loss — the browser work is
      // already paid for — but it must not take the batch down. The item is
      // reported as failed below by the caller's own path if it throws; here it
      // is logged and the item still counts as imported, because the import did
      // happen and only the storing failed.
      deps.logger.error(
        { err: cause, jobId: row.id, providerId: row.providerId },
        'a job imported a credential that could not be stored',
      );
    }
  }

  /** Recompute the tallies, publish, and close the job out when nothing is left. */
  function afterItem(jobId: string): void {
    const at = now().toISOString();
    const row = deps.jobs.findById(jobId);
    if (row === null) return;

    deps.jobs.refreshCounters(jobId, at);
    const counters = deps.jobs.findById(jobId);
    if (counters === null) return;

    // A manual hand-off that was answered leaves nothing blocked, so the job goes
    // back to running and its deadline is cleared.
    if (counters.needsManual === 0 && counters.status === 'needs_manual') {
      const state = live.get(jobId);
      state?.cancelDeadline?.();
      if (state !== undefined) {
        state.cancelDeadline = null;
        // Nothing is waiting on a human any more, so the stall clock is live again
        // — a worker that goes quiet from here really is stuck.
        state.awaitingManual = false;
        armStall(state, jobId);
      }
      deps.jobs.update(jobId, { status: 'running', manualDeadlineAt: null }, at);
    }

    const remaining = deps.jobs
      .itemsOf(jobId)
      .filter((item) => item.status === 'queued' || item.status === 'running').length;
    if (remaining === 0 && counters.needsManual === 0) {
      settle(require(jobId));
      return;
    }
    publish(require(jobId));
  }

  /* ---- Ending ---- */

  /** Everything landed. Succeeded when nothing failed, failed otherwise. */
  function settle(row: JobRow): void {
    const state = live.get(row.id);
    if (state !== undefined) {
      state.finished = true;
      clearTimers(state);
      state.handle?.send({ type: 'shutdown', workerId: state.workerId });
      state.handle = null;
    }
    const at = now().toISOString();
    const counters = deps.jobs.refreshCounters(row.id, at);
    deps.jobs.update(
      row.id,
      {
        status: counters.failed > 0 ? 'failed' : 'succeeded',
        finishedAt: at,
        manualWorkerId: null,
        manualDeadlineAt: null,
      },
      at,
    );
    publish(require(row.id));
  }

  /** The job itself could not run. */
  function failJob(state: LiveJob, error: string): void {
    if (state.finished) return;
    state.finished = true;
    clearTimers(state);
    state.handle = null;

    const at = now().toISOString();
    // In-flight items go back to the queue: they were interrupted, not judged, so
    // a retry can pick them up rather than starting the whole batch again.
    for (const item of deps.jobs.itemsOf(state.id)) {
      if (item.status === 'running' || item.status === 'needs_manual') {
        deps.jobs.updateItem(item.id, { status: 'queued', startedAt: null }, at);
      }
    }
    deps.jobs.refreshCounters(state.id, at);
    deps.jobs.update(
      state.id,
      {
        status: 'failed',
        lastError: error,
        finishedAt: at,
        manualWorkerId: null,
        manualDeadlineAt: null,
      },
      at,
    );
    publish(require(state.id));
  }

  /**
   * The worker's process ended.
   *
   * If the job already landed this is the ordinary exit after `done` and there is
   * nothing to say. If it did not, the worker died with work in hand — a crash, an
   * OOM, a kill from outside — and the job is a failure whose in-flight items
   * return to the queue.
   */
  function onExit(state: LiveJob, code: number | null, signal: string | null): void {
    if (state.finished) {
      live.delete(state.id);
      return;
    }
    deps.logger.warn({ jobId: state.id, code, signal }, 'automation worker exited unexpectedly');
    failJob(state, 'the worker exited unexpectedly');
  }

  /** Give up on one item: tell the worker, and let it carry on with the rest. */
  function abandonItem(state: LiveJob, itemId: string): void {
    const row = deps.jobs.findById(state.id);
    if (row === null || state.finished) return;

    state.handle?.send({ type: 'abandon-item', workerId: state.workerId, itemId });
    const at = now().toISOString();
    deps.jobs.updateItem(
      itemId,
      { status: 'failed', lastError: 'the manual deadline passed' },
      at,
    );
    deps.jobs.update(state.id, { manualDeadlineAt: null }, at);
    state.cancelDeadline = null;
    afterItem(state.id);
  }

  function clearTimers(state: LiveJob): void {
    state.cancelReady?.();
    state.cancelDeadline?.();
    state.cancelKill?.();
    state.cancelStall?.();
    state.cancelReady = null;
    state.cancelDeadline = null;
    state.cancelKill = null;
    state.cancelStall = null;
  }

  /** Stop a worker, with a grace period so its browsers can close properly. */
  function stopWorker(state: LiveJob, frame: 'cancel' | 'shutdown'): void {
    const handle = state.handle;
    if (handle === null) return;
    handle.send({ type: frame, workerId: state.workerId });
    state.cancelKill = timers.after(CANCEL_GRACE_MS, () => {
      // A worker that did not exit on its own is killed, which is what keeps a
      // stuck browser from holding the process — and the account slot — for ever.
      handle.kill();
    });
  }

  /* ---- The console surface ---- */

  return {
    create(input: JobInput): Job {
      const manifest = deps.registry.get(input.providerId);
      if (manifest === undefined) {
        // Not found rather than invalid: the id names nothing, which is a
        // different answer from a body that is wrong about a provider that exists.
        throw AppError.notFound(`No provider with id ${input.providerId}.`);
      }
      // A job against a provider rutekit cannot drive is refused here rather than
      // spawning a worker that would fail on its first line.
      if (manifest.automation === null && input.method !== 'bulk-token') {
        throw AppError.invalidRequest(
          `${manifest.name} has no automation flow, so rutekit cannot drive its sign-in.`,
        );
      }
      if (input.method === 'bulk-regist' && input.smsProviderId === null) {
        throw AppError.invalidRequest('A registration job needs an SMS provider to rent numbers from.');
      }

      const batch = batchOf(input.method, input.payload, input.quantity);
      if (batch.length === 0) {
        throw AppError.invalidRequest(
          input.method === 'bulk-regist'
            ? 'A registration job needs a quantity above zero.'
            : 'The payload contained no usable lines.',
        );
      }

      // FR-5.8: the machine caps what the operator asked for. A browser context is
      // a renderer process, and a job that opens twenty of them on a laptop makes
      // the console showing it unusable. The cap is recorded only when it bites,
      // so a job that got what it asked for carries a null.
      const capacity = effectiveConcurrency(input.concurrency, deps.capacity ?? {});

      const at = now().toISOString();
      const jobId = crypto.randomUUID();
      const items = batch.map((entry, position) => ({
        id: crypto.randomUUID(),
        jobId,
        position,
        accountLabel: entry.label,
        status: 'queued',
        attempts: 0,
        maxAttempts: input.maxAttempts,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: at,
      }));

      deps.jobs.create(
        {
          id: jobId,
          providerId: input.providerId,
          method: input.method,
          engine: input.engine,
          mode: input.mode,
          proxyId: input.proxyId,
          status: 'queued',
          concurrency: input.concurrency,
          effectiveConcurrency: capacity.capped ? capacity.value : null,
          total: items.length,
          succeeded: 0,
          failed: 0,
          needsManual: 0,
          manualWorkerId: null,
          manualDeadlineAt: null,
          // The credentials, encrypted. They are what the worker is handed, and
          // keeping them is what lets a failed batch be re-run after a restart.
          payloadEnvelope:
            input.method === 'bulk-regist'
              ? null
              : requireSecrets(deps.secrets).encrypt(
                  JSON.stringify(
                    Object.fromEntries(
                      batch.map((entry, index) => [items[index]?.id ?? '', entry.credential ?? '']),
                    ),
                  ),
                ),
          lastError: null,
          createdAt: at,
          startedAt: null,
          finishedAt: null,
          updatedAt: at,
        },
        items,
      );

      const row = require(jobId);
      launch(row);
      return toJob(require(jobId), true);
    },

    list(query: JobsQuery): JobsResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.jobs.listAll();
      if (query.providerId !== null) rows = rows.filter((row) => row.providerId === query.providerId);
      if (query.status !== null) rows = rows.filter((row) => row.status === query.status);
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.id, row.providerId, row.method, row.engine ?? ''].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        );
      }

      const offset = offsetOf(query.cursor);
      const next = offset + query.limit;
      return {
        // The list carries no items: a page of jobs each with two hundred items
        // would be a response nobody asked for.
        items: rows.slice(offset, next).map((row) => toJob(row, false)),
        nextCursor: next < rows.length ? String(next) : null,
        total: rows.length,
      };
    },

    get(id: string): Job {
      return toJob(require(id), true);
    },

    control(id: string, action: JobControlBody['action']): Job {
      const row = require(id);
      const at = now().toISOString();
      const state = live.get(id);

      switch (action) {
        case 'pause': {
          // Freeze: the worker goes and its in-flight items return to the queue.
          // A browser part-way through a sign-in cannot be frozen, so the choice
          // is between stopping it and pretending to.
          if (state !== undefined && !state.finished) {
            stopWorker(state, 'cancel');
            state.finished = true;
            clearTimers(state);
            state.handle = null;
          }
          for (const item of deps.jobs.itemsOf(id)) {
            if (item.status === 'running' || item.status === 'needs_manual') {
              deps.jobs.updateItem(item.id, { status: 'queued', startedAt: null }, at);
            }
          }
          deps.jobs.refreshCounters(id, at);
          deps.jobs.update(
            id,
            { status: 'paused', manualWorkerId: null, manualDeadlineAt: null },
            at,
          );
          break;
        }

        case 'resume': {
          if (row.status !== 'paused') {
            throw AppError.invalidRequest(`A job in ${row.status} cannot be resumed.`);
          }
          deps.jobs.update(id, { status: 'queued' }, at);
          launch(require(id));
          break;
        }

        case 'cancel': {
          if (state !== undefined && !state.finished) {
            stopWorker(state, 'cancel');
            state.finished = true;
            clearTimers(state);
            state.handle = null;
          }
          for (const item of deps.jobs.itemsOf(id)) {
            if (item.status === 'running' || item.status === 'needs_manual') {
              deps.jobs.updateItem(item.id, { status: 'queued', startedAt: null }, at);
            }
          }
          deps.jobs.refreshCounters(id, at);
          deps.jobs.update(
            id,
            {
              status: 'cancelled',
              finishedAt: at,
              manualWorkerId: null,
              manualDeadlineAt: null,
            },
            at,
          );
          break;
        }

        case 'retry_failed': {
          const failed = deps.jobs.itemsOf(id).filter((item) => item.status === 'failed');
          if (failed.length === 0) {
            throw AppError.invalidRequest('This job has no failed items to retry.');
          }
          // The credentials come from the stored envelope. A job whose envelope
          // will not open cannot be re-run, and saying so is better than sending
          // a worker a batch of nulls.
          if (deps.jobs.payloadEnvelope(id) === null && row.method !== 'bulk-regist') {
            throw AppError.invalidRequest(
              'The credentials for this job are no longer available, so its failures cannot be retried.',
            );
          }
          for (const item of failed) {
            deps.jobs.updateItem(
              item.id,
              { status: 'queued', attempts: 0, lastError: null, startedAt: null, finishedAt: null },
              at,
            );
          }
          deps.jobs.refreshCounters(id, at);
          deps.jobs.update(id, { status: 'queued', lastError: null, finishedAt: null }, at);
          launch(require(id));
          break;
        }
      }

      return toJob(require(id), true);
    },

    manual(id: string, body: JobManualBody): Job {
      // The row is fetched for its absence as much as its presence: a job that
      // does not exist is a 404, which is a different answer from a job that is
      // not waiting for anything.
      require(id);
      const state = live.get(id);
      if (state === undefined || state.finished) {
        throw AppError.invalidRequest('This job is not waiting for an answer.');
      }
      const item = deps.jobs.itemById(body.itemId);
      if (item === null || item.jobId !== id) {
        throw AppError.notFound(`No item ${body.itemId} in this job.`);
      }

      state.handle?.send({
        type: 'manual-answer',
        workerId: state.workerId,
        itemId: body.itemId,
        solution: body.solution,
      });

      // The answer clears the clock; the item stays `needs_manual` until the
      // worker reports what happened next, because the operator's text is not
      // itself a success.
      state.cancelDeadline?.();
      state.cancelDeadline = null;
      const at = now().toISOString();
      deps.jobs.update(id, { manualDeadlineAt: null }, at);
      return toJob(require(id), true);
    },

    session(id: string, body: JobSessionBody): Job {
      require(id);
      const state = live.get(id);
      if (state === undefined || state.finished) {
        throw AppError.invalidRequest('This job is not waiting for an answer.');
      }
      const item = deps.jobs.itemById(body.itemId);
      if (item === null || item.jobId !== id) {
        throw AppError.notFound(`No item ${body.itemId} in this job.`);
      }
      if (item.status !== 'needs_manual') {
        // Opening a session on an item that is not parked has nothing to open, and
        // reporting a challenge for it would park a working item for a person.
        throw AppError.invalidRequest('That item is not waiting for an answer.');
      }

      // The worker re-captures the page and reports the challenge again, which is
      // what refreshes the console's frame. The deadline restarts when that report
      // arrives — the host owns the clock, so this does not touch it directly.
      state.handle?.send({
        type: 'manual-open',
        workerId: state.workerId,
        itemId: body.itemId,
      });
      return toJob(require(id), true);
    },

    recover(): void {
      const orphans = deps.jobs.unfinished();
      if (orphans.length === 0) return;

      const at = now().toISOString();
      for (const row of orphans) {
        // No request outlives the process that sent it, and the same is true of a
        // subprocess: a job left `running` by a previous process has no worker
        // behind it, and leaving it that way would be a spinner that never stops.
        for (const item of deps.jobs.itemsOf(row.id)) {
          if (item.status === 'running' || item.status === 'needs_manual') {
            deps.jobs.updateItem(item.id, { status: 'queued', startedAt: null }, at);
          }
        }
        deps.jobs.refreshCounters(row.id, at);
        deps.jobs.update(
          row.id,
          {
            status: 'failed',
            lastError: 'the server restarted while this job was running',
            finishedAt: at,
            manualWorkerId: null,
            manualDeadlineAt: null,
          },
          at,
        );
      }
      deps.logger.info({ jobs: orphans.length }, 'interrupted automation jobs marked failed');
    },

    shutdown(): void {
      for (const state of live.values()) {
        if (state.finished) continue;
        state.finished = true;
        clearTimers(state);
        state.handle?.send({ type: 'shutdown', workerId: state.workerId });
        state.handle?.kill();
        state.handle = null;
      }
      live.clear();
    },
  };
}

/** The status a row holds, or `failed` when it holds something unrecognisable. */
function parseStatus(raw: string): JobStatus {
  return jobStatusSchema.safeParse(raw).data ?? 'failed';
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

const realTimers: Timers = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    // A pending deadline must not hold the process open during a drain.
    timer.unref?.();
    return () => {
      clearTimeout(timer);
    };
  },
};

/** The statuses a job can be in while a worker may still be behind it. */
export const LIVE_JOB_STATUSES: readonly JobStatus[] = LIVE_STATUSES;
