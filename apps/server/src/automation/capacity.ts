import { cpus, freemem } from 'node:os';

/**
 * How many browsers this machine should be running at once (C7c, FR-5.8).
 *
 * A browser context is not free: each one is a renderer process with its own
 * memory, and a job that asks for twenty on a two-core laptop makes the machine
 * unusable for whoever is sitting at it. The operator picks the number they want;
 * this is the ceiling the machine imposes on top of it.
 *
 * **A cap, never a floor.** The effective concurrency is
 * `min(requested, machineLimit)`, so an operator who asks for one gets one — which
 * matters, because running a single item is how somebody debugs a flow — and one
 * who asks for twenty on a small machine gets what the machine can carry. The cap
 * is reported on the job so a batch that is running slower than asked says why
 * rather than looking broken.
 *
 * **Two resources, and the tighter one wins.** Cores bound how much can genuinely
 * run in parallel; free memory bounds how many renderers fit. A machine with
 * thirty-two cores and two gigabytes free can still only hold a couple of
 * browsers, and a machine with sixty-four gigabytes free and two cores gains
 * nothing from a third context. So the limit is the smaller of the two.
 *
 * **Memory is read at the moment of the decision, not at boot.** A batch started
 * while the machine is idle and one started while a build is running should get
 * different answers, and the value is only used to cap a number the operator
 * already chose.
 */

/** What one browser context is assumed to need, in bytes. */
const BYTES_PER_CONTEXT = 512 * 1024 * 1024;

/**
 * Cores left for the rest of the machine.
 *
 * One, not zero: the server, SQLite and whatever the operator is doing all need a
 * core, and a cap that consumed every one of them would make the console that
 * shows the job unusable while the job runs.
 */
const RESERVED_CORES = 1;

export interface MachineLimit {
  /** The most contexts this machine should carry right now. */
  readonly limit: number;
  readonly cores: number;
  readonly freeMemoryBytes: number;
}

export interface CapacityOptions {
  /** Injectable so a test can describe a machine rather than run on one. */
  readonly cores?: number;
  readonly freeMemoryBytes?: number;
  /** Injectable for the same reason: a test sets its own clock. */
  readonly read?: () => { cores: number; freeMemoryBytes: number };
}

export function machineLimit(options: CapacityOptions = {}): MachineLimit {
  // The three ways to describe a machine, most explicit first: a `read` function
  // for a test that wants the values consulted at the moment of the decision, the
  // two plain numbers for one that just wants to name a machine, and the real
  // hardware when neither is given.
  const read =
    options.read ??
    (options.cores !== undefined && options.freeMemoryBytes !== undefined
      ? (): { cores: number; freeMemoryBytes: number } => ({
          cores: options.cores as number,
          freeMemoryBytes: options.freeMemoryBytes as number,
        })
      : (): { cores: number; freeMemoryBytes: number } => ({
          cores: cpus().length,
          freeMemoryBytes: freemem(),
        }));
  const { cores, freeMemoryBytes } = read();

  const byCores = Math.max(1, cores - RESERVED_CORES);
  const byMemory = Math.max(1, Math.floor(freeMemoryBytes / BYTES_PER_CONTEXT));

  // At least one, always: a machine under memory pressure still has to be able to
  // run a job, and refusing everything would be a cap that reads as a broken job.
  return { limit: Math.max(1, Math.min(byCores, byMemory)), cores, freeMemoryBytes };
}

/**
 * The concurrency a job will actually run at.
 *
 * Returns the effective number and whether the machine held it down, so the job
 * can say so. A silent cap is worse than no cap: an operator who asked for eight
 * and got two would read the slowness as a problem with the providers.
 */
export function effectiveConcurrency(
  requested: number,
  options: CapacityOptions = {},
): { readonly value: number; readonly capped: boolean; readonly machineLimit: number } {
  const { limit } = machineLimit(options);
  const value = Math.max(1, Math.min(requested, limit));
  return { value, capped: value < requested, machineLimit: limit };
}
