/**
 * The flows that are in flight (C3b2).
 *
 * A sign-in is two requests with a trip to the provider in between, so something
 * has to remember the verifier and the redirect that the first one minted. It is
 * held in memory, and deliberately: the value is worthless once the flow ends,
 * it lives for minutes, and the alternative — a table, a migration and a sweep
 * job — would be persistence for a value nothing survives a restart to use. A
 * restart abandons the sign-in and the operator clicks again, which is the whole
 * of the cost.
 *
 * That reasoning is only sound while rutekit is one process (ADR-0008). A second
 * instance behind a load balancer would send the callback to a process holding no
 * verifier, so this is one of the places the single-instance assumption is
 * written down rather than assumed.
 *
 * A state is single-use. `take` removes what it returns, so a replayed callback
 * finds nothing rather than trading the same code twice.
 */

/** How long a started sign-in may sit unclaimed before it is swept. */
export const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;

export interface PendingFlow {
  readonly providerId: string;
  /** Null for a flow the manifest declared without PKCE. */
  readonly codeVerifier: string | null;
  /** The exact URI the exchange must repeat. */
  readonly redirectUri: string;
  readonly createdAtMs: number;
}

export interface PendingFlows {
  put(state: string, flow: PendingFlow): void;
  /** Read and remove: a state that has been used cannot be used again. */
  take(state: string, atMs: number): PendingFlow | null;
  /** Drop everything past its TTL; returns how many went. */
  sweep(atMs: number): number;
  readonly size: number;
}

export interface PendingFlowsOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export function createPendingFlows(options: PendingFlowsOptions = {}): PendingFlows {
  const ttlMs = options.ttlMs ?? DEFAULT_PENDING_TTL_MS;
  const now = options.now ?? ((): number => Date.now());
  const flows = new Map<string, PendingFlow>();

  function expired(flow: PendingFlow, atMs: number): boolean {
    return atMs - flow.createdAtMs > ttlMs;
  }

  function sweep(atMs: number): number {
    let dropped = 0;
    for (const [state, flow] of flows) {
      if (expired(flow, atMs)) {
        flows.delete(state);
        dropped += 1;
      }
    }
    return dropped;
  }

  return {
    put(state: string, flow: PendingFlow): void {
      // Opportunistic rather than scheduled: every start is a moment when the map
      // has just grown, so it is the cheapest possible time to notice it should
      // not have. That bounds the map by the TTL and the start rate, with no
      // interval for `main.ts` to remember to clear on shutdown.
      sweep(now());
      flows.set(state, flow);
    },

    take(state: string, atMs: number): PendingFlow | null {
      const flow = flows.get(state);
      if (flow === undefined) return null;
      flows.delete(state);
      return expired(flow, atMs) ? null : flow;
    },

    sweep,

    get size(): number {
      return flows.size;
    },
  };
}
