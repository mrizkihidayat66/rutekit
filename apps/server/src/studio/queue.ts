import type { GenerationJob, StudioGenerateBody } from '@contracts';
import type { Logger } from 'pino';
import type { ProviderRegistry } from '@registry';

import { AppError } from '@server/errors.ts';
import type { StudioGenerationRow, StudioRepository } from '@server/persistence/studio.ts';
import {
  RenderCancelledError,
  noMediaDriver,
  type MediaDrivers,
  type MediaRequest,
} from '@server/studio/driver.ts';
import type { AssetStorage } from '@server/studio/storage.ts';

import { toGenerationJob } from './catalog.ts';

/**
 * The generation queue (C10, FR-8.1–8.6).
 *
 * `submit → queued → executing → progress → executed`, with an asset at the end
 * of it. Four things here are worth stating rather than reading out of the code.
 *
 * **It runs in this process, and that is a deliberate difference from C7.** The
 * automation worker is a Node subprocess because Playwright needs one. A media
 * render needs an HTTP call and a websocket — no browser, no CPU work on this
 * side, nothing that a second process would isolate. A subprocess here would buy
 * a stdio protocol and a lifecycle to babysit in exchange for nothing, so the
 * queue is async tasks in the server that already exists.
 *
 * **Concurrency is a cap, not a scheduler.** At most N renders are in flight, and
 * the rest wait in `queued`. There is no priority, no fairness policy and no
 * backpressure: a local ComfyUI serialises internally anyway, and a hosted
 * endpoint's own rate limit is the real ceiling. The cap exists so a batch of
 * eight does not open eight sockets at once to a renderer that will run them one
 * at a time regardless.
 *
 * **The database is what a cancel acts on, not the driver.** A job still `queued`
 * is cancelled by writing the status — `takeNext` only ever claims `queued`, so a
 * cancelled row is never picked up. A job already running is cancelled by
 * aborting its controller. Doing it the other way round — asking the driver to
 * stop and then recording it — would leave a window where a render the operator
 * already stopped still starts.
 *
 * **Progress is written at a coarser grain than it is reported.** A thirty-step
 * sampler emits thirty `progress` messages, and thirty SQLite writes per render
 * is a lot of I/O for a bar that moves two pixels. Writes are skipped unless the
 * fraction moved by a visible amount or the stage changed; the terminal states are
 * always written.
 */

/** How much the fraction must move before it is worth a row write. */
const PROGRESS_EPSILON = 0.02;

export interface StudioQueue {
  /** Queue a batch. Every job comes back `queued`, or none is created at all. */
  submit(body: StudioGenerateBody): GenerationJob[];
  /** Stop a render. Idempotent: cancelling a finished job changes nothing. */
  cancel(id: string): GenerationJob;
  /** Mark rows left live by a previous process as failed. Returns how many. */
  recover(): number;
  /** How many renders are in flight, for a log line. */
  inFlight(): number;
}

export interface StudioQueueDeps {
  readonly studio: StudioRepository;
  readonly drivers: MediaDrivers;
  readonly storage: AssetStorage;
  /** Which provider a job names, and what it is called in a message. */
  readonly registry: ProviderRegistry;
  readonly logger: Logger;
  /** At most this many renders run at once; the rest wait in `queued`. */
  readonly concurrency: number;
  /** How long one render may take before it is failed. */
  readonly timeoutMs: number;
  /**
   * Where a job's movement goes for a socket client.
   *
   * Called after each row write, so a pushed frame and a polled read never
   * disagree about where a job is.
   */
  readonly publish: (job: GenerationJob) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export function createStudioQueue(deps: StudioQueueDeps): StudioQueue {
  const now = deps.now ?? ((): Date => new Date());
  const newId = deps.newId ?? ((): string => crypto.randomUUID());

  /**
   * The renders this process is running, by job id.
   *
   * `cancelled` is the queue's own flag rather than the controller's, because the
   * controller aborts for two different reasons — an operator stopped the render,
   * or it ran out of clock — and those are two different outcomes. Reading the
   * signal alone could not tell them apart, and reporting a timeout as a cancel
   * would tell an operator they stopped something they did not.
   */
  const active = new Map<string, { readonly controller: AbortController; cancelled: boolean }>();

  function requireJob(id: string): StudioGenerationRow {
    const row = deps.studio.findGeneration(id);
    if (row === null) throw AppError.notFound(`No generation with id ${id}.`);
    return row;
  }

  /** Write a job's movement, publish it, and answer with the contract's shape. */
  function move(
    id: string,
    patch: Parameters<StudioRepository['updateGeneration']>[1],
  ): GenerationJob {
    deps.studio.updateGeneration(id, patch);
    const job = toGenerationJob(requireJob(id));
    deps.publish(job);
    return job;
  }

  async function run(
    job: StudioGenerationRow,
    slot: { readonly controller: AbortController; cancelled: boolean },
  ): Promise<void> {
    let lastFraction: number | null = null;
    let lastStage: string | null = null;

    // **The deadline is the queue's, not the driver's.** A driver that hangs
    // would otherwise hang the job for ever, and a per-driver clock is a clock
    // each driver has to remember to implement — which is the same mistake C7b
    // named for the manual deadline: the clock that abandons and the clock the
    // console reads have to be one clock. The abort asks the driver to stop; the
    // race below is what stops the queue waiting even if it does not.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        slot.controller.abort();
        reject(new Error(`The render ran out of time after ${String(deps.timeoutMs)} ms.`));
      }, deps.timeoutMs);
      // Unreferenced so a pending render never keeps the process alive on its
      // own — the server's own lifecycle decides when it exits, not a job.
      timer.unref?.();
    });

    try {
      const driver = deps.drivers.for(job.providerId);
      if (driver === null) {
        throw noMediaDriver(
          deps.registry.all().find((manifest) => manifest.id === job.providerId)?.name ??
            job.providerId,
          deps.drivers.served(),
        );
      }

      const request: MediaRequest = {
        kind: job.kind === 'video' ? 'video' : 'image',
        model: job.model,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        parameters: job.parameters,
      };

      const output = await Promise.race([
        driver.generate(request, {
          signal: slot.controller.signal,
          onProgress: (progress) => {
            // The stage is what an operator reads; the fraction is what the bar
            // draws. A message that moves neither is one that would only cost I/O.
            const moved =
              progress.progress === null ||
              lastFraction === null ||
              Math.abs(progress.progress - lastFraction) >= PROGRESS_EPSILON;
            if (!moved && progress.stage === lastStage) return;
            lastFraction = progress.progress ?? lastFraction;
            lastStage = progress.stage;

            move(job.id, {
              status: progress.progress === null ? 'executing' : 'progress',
              progress: progress.progress,
              stage: progress.stage,
            });
          },
        }),
        expired,
      ]);

      if (slot.cancelled) throw new RenderCancelledError();

      // The row is written before the file, so a crash between the two leaves an
      // asset listed with no bytes rather than bytes on disk nothing points at.
      // The first is a broken image the console already knows how to render; the
      // second is an orphan that only a manual sweep would find.
      const assetId = newId();
      const stored = await deps.storage.put(assetId, output.extension, output.bytes);

      deps.studio.createAsset({
        id: assetId,
        kind: job.kind,
        mimeType: stored.mimeType,
        extension: stored.extension,
        thumbnailExtension: null,
        byteSize: stored.byteSize,
        width: output.width,
        height: output.height,
        durationSeconds: output.durationSeconds,
        providerId: job.providerId,
        model: job.model,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        parameters: job.parameters,
        parentAssetId: job.parentAssetId,
        favorite: false,
        createdAt: now().toISOString(),
      });

      move(job.id, {
        status: 'executed',
        progress: 1,
        stage: 'Done',
        assetId,
        error: null,
        finishedAt: now().toISOString(),
      });
    } catch (error) {
      // A cancel is not a failure: the operator stopped it, and reporting it as
      // something that went wrong would send them looking for a cause. The flag
      // is what separates the two, because the deadline aborts the same
      // controller — and a render that ran out of clock is a failure, not
      // something anybody asked to stop.
      const cancelled = slot.cancelled || error instanceof RenderCancelledError;
      move(job.id, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: cancelled ? 'Cancelled' : 'Failed',
        error: cancelled ? null : describe(error),
        finishedAt: now().toISOString(),
      });
      if (!cancelled) {
        deps.logger.warn(
          { err: error, generationId: job.id, providerId: job.providerId },
          'a studio render failed',
        );
      }
    } finally {
      // Cleared on every exit, not only the one that timed out. A render that
      // finished in two seconds would otherwise leave a timer armed for the full
      // ceiling, and at a fifteen-minute default with a busy gallery that is a
      // pile of timers waiting to fire at nothing.
      if (timer !== undefined) clearTimeout(timer);
      active.delete(job.id);
      // The slot is free, so the next queued job starts here rather than waiting
      // for the next submit — a batch drains at the cap instead of one at a time.
      pump();
    }
  }

  /** Start as many queued jobs as the cap allows. */
  function pump(): void {
    while (active.size < deps.concurrency) {
      const next = deps.studio.takeNext();
      if (next === null) return;
      const slot = { controller: new AbortController(), cancelled: false };
      active.set(next.id, slot);
      void run(next, slot);
    }
  }

  return {
    submit(body: StudioGenerateBody): GenerationJob[] {
      const provider = deps.registry
        .all()
        .find((manifest) => manifest.id === body.providerId);
      if (provider === undefined) {
        throw AppError.notFound(`No provider with id ${body.providerId}.`);
      }

      const at = now().toISOString();
      const rows = deps.studio.createGenerations(
        Array.from({ length: body.count }, () => ({
          id: newId(),
          kind: body.kind,
          status: 'queued',
          providerId: body.providerId,
          model: body.model,
          prompt: body.prompt,
          negativePrompt: body.negativePrompt,
          progress: null,
          stage: 'Waiting for a worker',
          assetId: null,
          error: null,
          parameters: { ...body.parameters },
          parentAssetId: body.parentAssetId,
          createdAt: at,
          startedAt: null,
          finishedAt: null,
        })),
      );

      const jobs = rows.map(toGenerationJob);
      for (const job of jobs) deps.publish(job);
      pump();
      return jobs;
    },

    cancel(id: string): GenerationJob {
      const row = requireJob(id);
      const slot = active.get(id);

      if (slot !== undefined) {
        // Running: the flag says why this abort happened, the abort makes the
        // driver stop, and the job's own runner writes `cancelled` from its
        // catch. Writing the status here too would race that write.
        slot.cancelled = true;
        slot.controller.abort();
        return toGenerationJob(requireJob(id));
      }

      // Not running. `queued` becomes `cancelled` so `takeNext` never claims it;
      // a job that already finished is left exactly as it is.
      if (row.status === 'queued') {
        return move(id, { status: 'cancelled', stage: 'Cancelled', finishedAt: now().toISOString() });
      }
      return toGenerationJob(row);
    },

    recover(): number {
      const moved = deps.studio.interruptLive(
        'The server restarted while this render was running.',
        now().toISOString(),
      );
      // Published, not just written. A client watching the queue over the socket
      // would otherwise keep showing those rows as still working — the frames
      // that would have said otherwise were never sent, because the process that
      // would have sent them is the one that died.
      for (const row of moved) deps.publish(toGenerationJob(row));
      return moved.length;
    },

    inFlight(): number {
      return active.size;
    },
  };
}

/** A failure as one line an operator can act on. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The render failed for no reason the driver reported.';
}
