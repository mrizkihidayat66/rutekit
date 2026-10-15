import type { Logger } from 'pino';
import type { Usage } from '@contracts';
import { requestBytes, runPipeline } from '@compression';
import type { StageReport } from '@compression';
import type { ProviderManifest } from '@registry';
import { applyAuth, endpointUrl, withQuery } from '@registry';
import type {
  CanonicalRequest,
  CanonicalResult,
  CodecContext,
  StreamDecoder,
  StreamRenderer,
  WireCodec,
} from '@translator';
import type { IdFactory } from '@shared';

import { AppError } from '@server/errors.ts';
import { degrade, type ControlKind } from '@server/plan/capability.ts';
import type { Pool } from '@server/pool/pool.ts';
import type { ServerConfig } from '@server/runtime/config.ts';
import type { TokenSaverSettings } from '@server/runtime/token-saver.ts';
import { applyPhase, type FilterRuleLike } from '@server/tools/filters.ts';

import { asJson } from './dispatch-errors.ts';
import type { ResponseFetcher } from './outbound.ts';
import { callProvider, type StreamEnd } from './provider-call.ts';

/**
 * One call to one model (C9).
 *
 * This is the part of a turn that is the same whoever asked for it: take a lease
 * from the pool, run the Token Saver, encode for the provider's wire, build the
 * URL and the credential, call, and hand back whatever the provider said — as the
 * caller's renderers chose to render it.
 *
 * It exists because there are two front doors and only one way in. `/v1` arrives
 * with a plan and an API key and walks a chain of candidates; the chat console
 * arrives with a provider and a model an operator picked, and has no key at all.
 * Everything *after* the choice is identical, and having it in two places would
 * mean two implementations of the same call that drift the first time either
 * changes — which is the thing the translator's pivot exists to prevent one layer
 * down.
 *
 * **The outbound body is one span, and this file owns all of it.** Degrade for
 * the model that was chosen, compress, run the phase-2 filters, encode. The order
 * is an invariant rather than a preference: the pipeline has to see the body that
 * will actually be sent (so the model's own limits are applied first), and a
 * phase-2 rule exists precisely to catch what the pipeline produced (so it runs
 * after). Splitting those four steps across two front doors is how the order
 * would quietly diverge, so they are one function here.
 *
 * What is *not* here is everything that decides **what** is being sent: ingesting
 * the client's body, phase-1 filtering, resolving a name to a candidate, checking
 * a key's scope. Those read the request, so they belong to the front door that
 * knows what the request means — and the phase-1 filter has to run before routing
 * because the ranking looks at the controls the request carries.
 *
 * **The renderers are the seam.** A caller passes the two functions that turn a
 * canonical answer into its own surface's bytes: one for a whole answer, one for
 * a stream. `/v1` passes the surface renderers; chat passes the AI SDK's. This
 * module never learns which dialect it is speaking, and neither renderer learns
 * that a pool exists.
 *
 * **A busy pool is an exception, not a null.** The dispatcher wants to try the
 * next candidate when a provider has no account free, and chat has no next
 * candidate — so the caller that cares catches `NoAccountError` and the caller
 * that does not lets it become a message. Returning null would make "busy" and
 * "this candidate cannot serve you" the same value at the boundary, and the two
 * callers need them apart.
 */

/** Which model is being called, and how. */
export interface ModelCall {
  readonly manifest: ProviderManifest;
  /** The id rutekit resolved, for logging and the codec's own context. */
  readonly modelId: string;
  /** The id the provider expects on the wire. */
  readonly upstreamId: string;
  readonly codec: WireCodec;
  /**
   * Whether the provider's own bytes are the answer.
   *
   * A pair whose two dialects are the same one — an OpenAI client to an OpenAI
   * provider — is not re-rendered, because doing so would cost exactly the fields
   * the pivot does not model. The renderers are still passed, because usage has to
   * be read out of the answer either way.
   */
  readonly direct: boolean;
  /** Controls this model cannot express, dropped before anything is sent. */
  readonly dropped: readonly ControlKind[];
}

/** How a caller turns a canonical answer into its own surface's bytes. */
export interface CallRenderers {
  /**
   * A whole answer. Ignored on the direct route, where the provider's bytes are
   * the answer.
   *
   * Omitted by a caller that only ever streams — the chat console's protocol has
   * no non-streaming form — and asking for one anyway is a fault in the caller
   * rather than in the request, which is why it is refused rather than guessed at.
   */
  readonly render?: ((result: CanonicalResult) => unknown) | undefined;
  /** A stream, or null on the direct route where there is nothing to render frames with. */
  readonly stream: () => StreamRenderer | null;
}

export interface ModelCallDeps {
  readonly pool: Pool;
  readonly tokenSaver: TokenSaverSettings;
  /** The client's own content filters (C8), read per turn. */
  readonly filters: () => readonly FilterRuleLike[];
  readonly fetch: ResponseFetcher;
  readonly config: ServerConfig;
  readonly logger: Logger;
  /** Unix seconds, for the codec's clock. */
  readonly now: () => number;
  readonly ids: IdFactory;
}

/**
 * What the Token Saver did to one turn's request.
 *
 * The pipeline's own `StageReport`s plus the two sizes they started and ended at,
 * carried out to whoever is recording the turn. It is a **fact about the request**,
 * known before the call is sent, which is why it is reported here rather than
 * alongside the answer: a turn that is compressed and then refused upstream still
 * saved the tokens, and a savings figure that only counted successful turns would
 * quietly understate the feature.
 */
export interface CompressionReport {
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly stages: readonly StageReport[];
}

export interface ModelCallHooks {
  /** The body that actually leaves rutekit, for the request inspector. */
  readonly onUpstreamRequest?: ((body: unknown) => void) | undefined;
  /**
   * What the Token Saver removed, once the outbound body is final (C14).
   *
   * Called before the lease is taken, so it fires whether or not the turn goes on
   * to reach a provider.
   */
  readonly onCompression?: ((report: CompressionReport) => void) | undefined;
  /**
   * The account this turn was sent as, once one was taken.
   *
   * Called before the provider is reached, so a caller recording a telemetry row
   * can name the account even when the call then fails.
   */
  readonly onLease?: ((accountId: string) => void) | undefined;
  /** A whole answer's usage, once it is decoded. */
  readonly onResult?: ((usage: Usage | null) => void) | undefined;
  /** The stream's first bytes, which is the turn's time to first token. */
  readonly onFirstChunk?: (() => void) | undefined;
  /**
   * How a stream ended.
   *
   * A stream is the one shape whose outcome lands after the 200 went out, so its
   * accounting happens here rather than at the return below.
   */
  readonly onStreamEnd?: ((end: StreamEnd) => void) | undefined;
}

export interface ModelCallResult {
  readonly response: Response;
  readonly accountId: string;
  /** The usage a whole answer reported. Null for a stream, whose usage lands later. */
  readonly usage: Usage | null;
}

/** No account this provider has can take a turn right now. Busy, not broken. */
export class NoAccountError extends Error {
  constructor(providerName: string) {
    super(`No ${providerName} account can take a turn right now.`);
    this.name = 'NoAccountError';
  }
}

export async function callModel(
  deps: ModelCallDeps,
  request: CanonicalRequest,
  call: ModelCall,
  renderers: CallRenderers,
  requestId: string | null,
  hooks: ModelCallHooks = {},
): Promise<ModelCallResult> {
  const outbound = outboundRequest(request, call, deps, requestId);
  const encoded = call.codec.encodeRequest(outbound.request);
  const context: CodecContext = { now: deps.now, ids: deps.ids, model: call.modelId };

  // The body that actually leaves rutekit, after degradation, the Token Saver,
  // the phase-2 filters and the provider's own codec — which is the panel an
  // operator reads when the question is "what did we send, exactly".
  hooks.onUpstreamRequest?.(encoded.body);
  // Reported before the lease is taken, because what the Token Saver removed is
  // already settled by this point and does not depend on whether a provider
  // answers. See `CompressionReport`.
  hooks.onCompression?.(outbound.compression);

  const lease = deps.pool.acquire(call.manifest.id);
  if (lease === null) throw new NoAccountError(call.manifest.name);
  hooks.onLease?.(lease.accountId);

  // Everything from here holds the lease, so a throw anywhere below has to settle
  // it — a leaked lease would keep the account's in-flight count up and quietly
  // shrink the pool for the life of the process.
  try {
    const target = endpointUrl(call.manifest, call.manifest.endpoint.chatPath ?? encoded.path, {});
    if (target.missing.length > 0) {
      // A templated base URL needs values this row has no column for, so the
      // refusal names the gap rather than calling a URL with a hole in it.
      throw AppError.unavailable(
        `${call.manifest.name} needs an account field rutekit does not store yet (${target.missing.join(', ')}).`,
      );
    }

    const auth = applyAuth(call.manifest, lease.credential.value);
    const url =
      Object.keys(auth.query).length === 0 ? target.url : withQuery(target.url, auth.query);

    let usage: Usage | null = null;

    const response = await callProvider(
      {
        manifest: call.manifest,
        url,
        headers: {
          'content-type': 'application/json',
          accept: request.stream ? 'text/event-stream' : 'application/json',
          ...call.manifest.endpoint.headers,
          ...auth.headers,
        },
        body: JSON.stringify(encoded.body),
        stream: request.stream,
      },
      {
        fetch: deps.fetch,
        config: deps.config,
        logger: deps.logger,
        requestId,
        render: (raw): unknown => {
          const result = call.codec.decodeResponse(asJson(raw), context);
          usage = result.usage;
          hooks.onResult?.(result.usage);
          if (call.direct) return null;
          // Null is `callProvider`'s "the provider's own bytes are the answer", so
          // a caller that cannot render one must not be answered with null here.
          if (renderers.render === undefined) {
            throw AppError.internal(new Error('this caller cannot render a whole answer'));
          }
          return renderers.render(result);
        },
        streamDecoder: (): StreamDecoder => call.codec.createStreamDecoder(context),
        renderer: (): StreamRenderer | null => (call.direct ? null : renderers.stream()),
        ...(hooks.onFirstChunk === undefined ? {} : { onFirstChunk: hooks.onFirstChunk }),
        onStreamEnd: (end) => {
          hooks.onStreamEnd?.(end);
        },
      },
    );

    // The headers are in hand, which for a stream is as much as this file will
    // ever know: a body that dies after them is the pump's problem, and the
    // release is idempotent so nothing can double-count it.
    lease.succeed();
    return { response, accountId: lease.accountId, usage };
  } catch (error) {
    lease.fail(error);
    throw error;
  }
}

/**
 * The pivot's request as it should leave rutekit, for this model.
 *
 * Four steps in an order that is the point of the function: drop what this model
 * cannot express, compress, let the phase-2 rules see what compression produced,
 * and address the result to the provider's own model id. The id is swapped last
 * so every earlier step sees the name the client asked for — a degradation message
 * naming a model is more useful with the id the operator recognises, and the
 * pipeline's own model-aware stages are written against rutekit's ids.
 */
function outboundRequest(
  request: CanonicalRequest,
  call: ModelCall,
  deps: ModelCallDeps,
  requestId: string | null,
): { request: CanonicalRequest; compression: CompressionReport } {
  const degraded =
    call.dropped.length === 0 ? request : degrade(request, call.dropped, call.modelId);
  if (call.dropped.length > 0) {
    deps.logger.warn(
      { requestId, model: call.modelId, dropped: [...call.dropped] },
      'request degraded: the model cannot express every control it carries',
    );
  }

  const addressed: CanonicalRequest = { ...degraded, model: call.upstreamId };
  // Fail-open is the pipeline's own guarantee (CONTRIBUTING §5.5): it returns the
  // request it was given when anything went wrong, so there is no error branch.
  const result = runPipeline(addressed, deps.tokenSaver.read());
  // Measured around the *pipeline*, not around the whole function: the phase-2
  // rules run after it, and folding their effect in would credit the Token Saver
  // with a redaction an operator's own filter made. The two are different
  // features and the page reports one of them.
  const compression: CompressionReport = {
    bytesIn: requestBytes(addressed),
    bytesOut: requestBytes(result.request),
    stages: result.stages,
  };
  return { request: applyPhase2(result.request, deps), compression };
}

/**
 * Phase 2, or a refusal.
 *
 * A `block` rule raises `invalid_request` naming the rule rather than a
 * `permission`: the request is one rutekit will not carry, which is a statement
 * about the body, and a 403 on `/v1` reads to an SDK as a credential problem.
 * Naming the rule is what makes it actionable — an operator who wrote it sees
 * which one fired, and the client sees a refusal that explains itself.
 *
 * Nothing is called upstream, so a blocked turn costs no quota.
 */
function applyPhase2(request: CanonicalRequest, deps: ModelCallDeps): CanonicalRequest {
  const outcome = applyPhase(request, deps.filters(), 2);
  if (outcome.kind === 'blocked') {
    throw AppError.invalidRequest(`This request was blocked by the rule "${outcome.rule.name}".`);
  }
  if (outcome.redactions > 0) {
    deps.logger.debug(
      { phase: 2, redactions: outcome.redactions },
      'content filters rewrote the request',
    );
  }
  return outcome.request;
}
