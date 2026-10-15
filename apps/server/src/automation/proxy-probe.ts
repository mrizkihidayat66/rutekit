import type { ProxyHealth } from '@contracts';

import { guardOutbound } from '@server/providers/outbound.ts';
import type { EgressPolicy } from '@server/security/egress.ts';

import { proxyUrl, type ParsedProxy } from './proxy-line.ts';

/**
 * Whether an egress actually works (C7a, FR-5.x).
 *
 * The pool page's whole value is the health column, and a health column that was
 * guessed is worse than none: an operator who reads "healthy" and watches a batch
 * fail has been told a lie by the page. So a check makes a real request through
 * the proxy and measures how long it took.
 *
 * **The proxy does the work, not rutekit.** Bun's `fetch` takes a `proxy` option
 * natively, so there is no agent to install and no socket to wire by hand — and
 * because it is the same `fetch` the rest of the server uses, a proxy that cannot
 * carry a request here is one that cannot carry a worker's either.
 *
 * **The probe target is a known-good public endpoint, and it is checked.** Both
 * the proxy's own address and the probe URL go through the egress guard, so a
 * pool entry pointing at a private address is refused rather than probed — the
 * proxy list is operator-supplied input like any other, and it is the one piece
 * of it that names a host rutekit will connect to.
 *
 * The verdict has three values rather than two. A proxy that answers in 900 ms is
 * not dead and is not healthy either: it works, and a batch driven through it
 * will be slow. Collapsing that into a boolean would lose the one distinction an
 * operator acts on when picking an egress.
 */

/** Under this, a proxy is healthy. */
const HEALTHY_MS = 1_500;
/** Under this, it is slow. At or over it — or a failure — it is dead. */
const SLOW_MS = 5_000;

export interface ProxyProbeResult {
  readonly health: ProxyHealth;
  /** Null when the probe never got an answer. */
  readonly latencyMs: number | null;
  /** Why it failed, for the log. Never shown to the client verbatim. */
  readonly error?: string;
}

export interface ProxyProbe {
  probe(proxy: ParsedProxy): Promise<ProxyProbeResult>;
}

export interface ProxyProbeDeps {
  readonly egress: EgressPolicy;
  /** Where the probe points. A small, fast, always-up endpoint. */
  readonly probeUrl: string;
  readonly timeoutMs: number;
  /** Injectable so a test needs no network. */
  readonly fetch?: ProxyFetch;
  readonly now?: () => number;
}

/**
 * The shape of the one call a probe makes.
 *
 * Declared here rather than using the global `fetch` type, because the `proxy`
 * option is Bun's own extension to `RequestInit` and naming it keeps the seam
 * honest: a test double has to accept the same thing the real one does.
 */
export type ProxyFetch = (
  url: string,
  init: RequestInit & { proxy: string },
) => Promise<Response>;

export function createProxyProbe(deps: ProxyProbeDeps): ProxyProbe {
  const now = deps.now ?? Date.now;
  const call = deps.fetch ?? globalProxyFetch;

  return {
    async probe(proxy: ParsedProxy): Promise<ProxyProbeResult> {
      const url = proxyUrl(proxy);

      // The proxy's own address is the one host here that rutekit connects to, so
      // it gets the same guard a provider URL does. A refusal is a failed probe
      // rather than a throw: an operator who pasted a private address should see
      // it marked, not watch the whole check fail.
      try {
        guardOutbound(deps.egress, url);
      } catch (cause) {
        return { health: 'dead', latencyMs: null, error: describe(cause) };
      }

      const started = now();
      try {
        const response = await call(deps.probeUrl, {
          method: 'GET',
          proxy: url,
          signal: AbortSignal.timeout(deps.timeoutMs),
          // A redirect is the proxy's business, not a second hop rutekit makes
          // without knowing where it lands.
          redirect: 'manual',
        });
        const latencyMs = now() - started;

        // Any HTTP answer proves the proxy carried the request. A 403 from the
        // target is a working egress, not a broken one — which is why the status
        // is not compared against 200.
        if (response.status === 0) {
          return { health: 'dead', latencyMs: null, error: 'no status' };
        }
        return {
          health: latencyMs <= HEALTHY_MS ? 'healthy' : latencyMs <= SLOW_MS ? 'slow' : 'dead',
          latencyMs,
        };
      } catch (cause) {
        // A timeout and a refusal are the same verdict — nothing came back — but
        // the reason is kept for the log, where the difference is diagnosable.
        return { health: 'dead', latencyMs: null, error: describe(cause) };
      }
    },
  };
}

const globalProxyFetch: ProxyFetch = (url, init) => fetch(url, init);

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the probe failed';
}
