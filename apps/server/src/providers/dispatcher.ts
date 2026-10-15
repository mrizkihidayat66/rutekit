import type { Logger } from 'pino';
import type { ErrorKind, Usage } from '@contracts';
import type { CanonicalRequest, ClientSurface } from '@translator';
import {
  chooseRoute,
  codecFor,
  createStreamRenderer,
  ingestRequest,
  renderResult,
} from '@translator';
import { createIdFactory, type IdFactory, type RandomSource } from '@shared';

import type { ApiKeyService } from '@server/api-keys/service.ts';
import { AppError, isAppError } from '@server/errors.ts';
import type { ApiKeyRow } from '@server/persistence/api-keys.ts';
import type { ControlKind } from '@server/plan/capability.ts';
import type { Planner, RankedStep, TurnPlan } from '@server/plan/plan.ts';
import type { Pool } from '@server/pool/pool.ts';
import { applyPhase, type FilterRuleLike } from '@server/tools/filters.ts';
import type { ServerConfig } from '@server/runtime/config.ts';
import type { TokenSaverSettings } from '@server/runtime/token-saver.ts';
import type { TelemetryRecorder, TurnRecord, TurnTarget } from '@server/telemetry/recorder.ts';

import {
  NoAccountError,
  callModel,
  type CompressionReport,
  type ModelCallDeps,
} from './model-call.ts';
import type { ResponseFetcher } from './outbound.ts';

/**
 * One `/v1` turn, from a client's body to a provider's answer (C4.6, C5b).
 *
 * This file is the **front door**: what the client's model name means, whether
 * the key may use it, and which candidate to try. The call itself — lease,
 * compression, encoding, the socket — lives in `model-call.ts`, because the chat
 * console needs exactly the same thing and there is only one way to send a turn.
 *
 * **The request always pivots.** `chooseRoute` is consulted, but it decides the
 * *answer* direction, not the question. The reason is the Token Saver: it works on
 * the canonical request, so a body forwarded verbatim is a body rutekit cannot
 * compress, and the two pairs `chooseRoute` calls exact are the two commonest ones
 * in the world. What the pivot would otherwise cost on the way in — fields the
 * canonical shape has never heard of — is already paid for by `extras`, which
 * every codec spreads back into the body it builds.
 *
 * On the way *out* the decision is real, and it is where the loss would be: a
 * re-rendered answer has been through the pivot, and a thinking block's signature
 * or a vendor's extra response fields do not survive that. So a `direct` pair
 * returns the provider's own bytes, which `model-call.ts` implements by being told
 * not to render.
 *
 * **A combo walks its chain, and only until the answer is committed.** C5b gave
 * this file a loop, and the loop's boundary is the important part: a step that
 * fails *before* anything has been sent to the client may be retried on the next
 * candidate, and a step that has already produced a 200 with a stream body may
 * not — there is no way to un-send the bytes, and starting a second upstream call
 * would produce two answers for one request. `callProvider` is what makes that
 * boundary observable: it returns once the headers are in hand, which is exactly
 * the moment the answer became a promise this file cannot take back.
 *
 * A candidate with no account free returns null from `attempt` — the same value a
 * candidate with an untranslatable wire returns — because for this caller they are
 * the same decision: nothing was sent, so try the next one. The chat console has
 * no next one, which is why `NoAccountError` exists as an error rather than a null.
 *
 * **Capability (C5c, FR-1.6) is decided here and applied in the call.** The plan's
 * candidates arrive ranked, each carrying the controls the model cannot express;
 * this file passes the list to the call, which drops them before compressing and
 * reports back, and the response carries an `x-rutekit-degraded` header naming
 * them. It never picks a different model to avoid the degradation — the ranking
 * already put the capable candidates first, and a candidate reached after those
 * failed is reached with its cost stated.
 */

export interface DispatchRequest {
  readonly surface: ClientSurface;
  readonly body: unknown;
  readonly apiKey: ApiKeyRow;
  readonly requestId: string | null;
}

export interface Dispatcher {
  /** The answer, ready to return. Throws an `AppError` for anything else. */
  complete(request: DispatchRequest): Promise<Response>;
}

export interface DispatcherDeps {
  /** What the client's model name means (C5b): mapping, alias, combo, catalogue. */
  readonly planner: Planner;
  /** The pool (C5): the only thing that chooses a credential, and the lease's owner. */
  readonly pool: Pool;
  readonly apiKeys: ApiKeyService;
  readonly fetch: ResponseFetcher;
  readonly tokenSaver: TokenSaverSettings;
  /** Where the per-request row goes (C6, FR-12.2). */
  readonly telemetry: TelemetryRecorder;
  /**
   * The client's own content filters (C8, FR-11.3), read per turn.
   *
   * A function rather than an array because the rules are the operator's and can
   * change while the process runs — the same reason the pool's strategy and the
   * low-stress switch are read on demand rather than captured at boot.
   */
  readonly filters: () => readonly FilterRuleLike[];
  readonly config: ServerConfig;
  readonly logger: Logger;
  /** Unix seconds, for the codec's clock. */
  readonly now?: () => number;
  /** Injectable so a test can assert the ids rutekit synthesises. */
  readonly ids?: IdFactory;
  readonly random?: RandomSource;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const ids = deps.ids ?? createIdFactory(deps.random ?? defaultRandom);

  // The call's own dependencies, assembled once. The clock and the id factory are
  // the resolved ones, not the optional fields: the call has no defaults of its
  // own, which is what keeps a test's injected ids reaching the codec.
  const callDeps: ModelCallDeps = {
    pool: deps.pool,
    tokenSaver: deps.tokenSaver,
    filters: deps.filters,
    fetch: deps.fetch,
    config: deps.config,
    logger: deps.logger,
    now,
    ids,
  };

  /** One attempt's context: the codec and the direction its answer comes back in. */
  function prepare(surface: ClientSurface, step: RankedStep) {
    const codec = codecFor(step.resolved.family);
    if (codec === null) return null;
    return {
      codec,
      direct: chooseRoute(surface, step.resolved.family) === 'direct',
    };
  }

  async function attempt(
    input: DispatchRequest,
    canonical: CanonicalRequest,
    step: RankedStep,
    state: TurnState,
  ): Promise<Response | null> {
    const prepared = prepare(input.surface, step);
    // A wire rutekit cannot translate is a reason to skip this candidate, not to
    // refuse the turn: a combo may legitimately mix a provider rutekit speaks for
    // with one it does not. A single-model plan has nowhere to go, and the caller
    // reports it.
    if (prepared === null) return null;

    try {
      const result = await callModel(
        callDeps,
        canonical,
        {
          manifest: step.resolved.manifest,
          modelId: step.resolved.model.id,
          upstreamId: step.resolved.upstreamId,
          codec: prepared.codec,
          direct: prepared.direct,
          dropped: step.degraded,
        },
        {
          render: (decoded) => renderResult(input.surface, decoded),
          stream: () => createStreamRenderer(input.surface),
        },
        input.requestId,
        {
          // The body that actually leaves rutekit, after degradation, the Token
          // Saver and the provider's own codec — which is the panel an operator
          // reads when the question is "what did we send, exactly".
          onUpstreamRequest: (body) => {
            deps.telemetry.capture(state.record, {
              stage: 'upstream_request',
              label: 'Upstream request',
              body,
            });
          },
          // What the row will say about the account. Recorded the moment the lease
          // is taken, so a turn that fails *after* this point still names the
          // provider and account it was sent to.
          onLease: (accountId) => {
            state.target = {
              manifest: step.resolved.manifest,
              model: step.resolved.model.id,
              accountId,
              upstreamModel: step.resolved.upstreamId,
            };
          },
          // Known before the provider is reached, so a turn that is compressed and
          // then refused still reports the tokens it saved.
          onCompression: (report) => {
            state.compression = report;
          },
          onResult: (usage) => {
            record(deps, input.apiKey, usage);
          },
          onFirstChunk: () => {
            state.ttftMs = Date.now() - state.record.startedAtMs;
          },
          onStreamEnd: (end) => {
            // The stream is the one shape whose outcome lands after the 200 went
            // out, so its row is written here rather than beside the return below.
            // Both endings come through this callback, so a stream that died is
            // still a row an operator can find.
            const reported = end.ok ? end.usage : null;
            record(deps, input.apiKey, reported);
            finishTurn(deps, state, {
              status: end.ok ? 200 : statusOf(end.error),
              errorKind: end.ok ? null : kindOf(end.error),
              usage: reported,
              ttftMs: state.ttftMs,
            });
          },
        },
      );

      // A non-streaming answer has already been rendered, so its usage and its
      // latency are both known and the row is written now. **A streaming one must
      // not be** — its body has not been read yet, so writing here would record a
      // 200 with no tokens and no first-token time, and the pump's own row would
      // then be suppressed by `finishTurn`'s guard. The stream writes its own.
      if (!canonical.stream) {
        finishTurn(deps, state, {
          status: 200,
          errorKind: null,
          usage: result.usage,
          ttftMs: null,
        });
      }
      return withDegradation(result.response, step.degraded);
    } catch (error) {
      // Every account of this provider is busy. Nothing was sent, so for a combo
      // this is the same decision as an untranslatable wire: try the next entry.
      if (error instanceof NoAccountError) return null;
      throw error;
    }
  }

  async function complete(input: DispatchRequest): Promise<Response> {
    const state: TurnState = {
      record: deps.telemetry.begin({
        method: 'POST',
        path: `/v1/${surfacePath(input.surface)}`,
        apiKeyId: input.apiKey.id,
        // Read from the body rather than from the pivot: a body that fails to
        // ingest has no pivot, and whether the client asked for a stream is a
        // fact about the request that survives even a malformed one.
        streamed: wantsStream(input.body),
        requestId: input.requestId,
      }),
      settled: false,
      ttftMs: null,
      target: null,
      compression: null,
    };

    // The client's own body, captured before anything can refuse it — a request
    // that failed validation is exactly the one an operator wants to read.
    deps.telemetry.capture(state.record, {
      stage: 'client_request',
      label: 'Client request',
      body: input.body,
    });

    try {
      // Phase 1 sees the body as it arrived, before the compression pipeline has
      // touched it (FR-11.3) — which is what a rule written against what the
      // client sends has to be measured against. It runs *before* routing on
      // purpose: the ranking reads the controls the request carries, so it has to
      // rank the body that will actually be sent.
      const canonical = applyFilters(ingest(input.surface, input.body), deps);
      // The pivot is what the routing decision acted on. The upstream body is
      // captured in the call, where the encoded request is in hand; the client
      // response is not captured at all — it is the provider's answer, and the row
      // already records what it cost and how it ended.
      deps.telemetry.capture(state.record, {
        stage: 'canonical',
        label: 'Canonical pivot',
        body: canonical,
      });
      return await dispatch(input, canonical, state);
    } catch (error) {
      // Every refusal that never reached a provider — an unknown model, a key
      // out of scope, a combo with nothing usable — is still a request the
      // operator asked for and the console has to show. So the row is written
      // here, once, with whatever the turn managed to learn before it failed.
      finishTurn(deps, state, {
        status: statusOf(error),
        errorKind: kindOf(error),
        usage: null,
        ttftMs: null,
      });
      throw error;
    }
  }

  async function dispatch(
    input: DispatchRequest,
    canonical: CanonicalRequest,
    state: TurnState,
  ): Promise<Response> {
    const plan = deps.planner.resolveFor(canonical.model, canonical);
    if (plan === null) {
      throw AppError.notFound(`No provider serves the model ${canonical.model}.`);
    }
    if (plan.steps.length === 0) {
      // A name that reached models, none of which can serve this request. Two
      // different faults land here and the message has to tell them apart: a
      // combo whose entries named nothing, and a request only an embedding model
      // could answer — which is not a chat turn at all.
      if (plan.refused.length > 0) {
        throw AppError.invalidRequest(
          `${plan.refused.join(', ')} cannot serve a chat turn; ${plan.refused.length === 1 ? 'it is an embedding model' : 'they are embedding models'}.`,
        );
      }
      throw AppError.unavailable(
        `The combo ${plan.comboName ?? canonical.model} has no usable entries (${plan.unresolved.join(', ')}).`,
      );
    }

    const permittedSteps = permitted(plan, input.apiKey, canonical.model);
    if (permittedSteps.length === 0) {
      throw AppError.permission(`This API key may not use ${canonical.model}.`);
    }
    // `fallbackOnError` off means "fail fast": only the best candidate is tried.
    // The field defaults to on, so the deliberate choice is the one that stops the
    // walk — which is the reading the console's own switch describes.
    const steps = plan.fallbackOnError ? permittedSteps : permittedSteps.slice(0, 1);

    let last: AppError = AppError.unavailable('No candidate could take the turn.');
    for (const [index, step] of steps.entries()) {
      const lastStep = index === steps.length - 1;
      try {
        const response = await attempt(input, canonical, step, state);
        if (response !== null) return response;
        // Null is "this candidate cannot take the turn" — a wire rutekit does not
        // speak, or every account busy. Nothing was sent upstream, so moving on
        // costs nothing but the walk itself.
        last = AppError.unavailable(
          `No ${step.resolved.manifest.name} account can take a turn right now.`,
        );
      } catch (error) {
        // The chain may only be walked while the client has been told nothing. A
        // step that threw failed before its headers, which is exactly that; a step
        // that got as far as a response returned instead of throwing. The final
        // step's own error is the most informative thing left to report, so it is
        // rethrown as caught rather than rewritten.
        if (lastStep) throw error;
        last = isAppError(error) ? error : AppError.internal(error);
        deps.logger.warn(
          { err: error, combo: plan.comboName, model: step.resolved.model.id },
          'combo entry failed; trying the next one',
        );
      }
    }

    throw last;
  }

  return { complete };
}

/**
 * What one turn has learned so far, shared between the two functions above.
 *
 * `settled` is the guard that keeps a stream's row from being written twice: the
 * stream writes its own row from the pump's terminal callback, long after the
 * call has returned, and the caller must not write a second one on top.
 */
interface TurnState {
  readonly record: TurnRecord;
  settled: boolean;
  ttftMs: number | null;
  target: TurnTarget | null;
  /**
   * What the Token Saver removed, captured before the call is sent (C14).
   *
   * Held on the state rather than read from the return value because a stream's
   * row is written from `onStreamEnd`, which fires long after `callModel`
   * returned — the same reason `target` and `ttftMs` live here.
   */
  compression: CompressionReport | null;
}

/** Write the row once, whatever else happens. */
function finishTurn(
  deps: DispatcherDeps,
  state: TurnState,
  outcome: {
    status: number;
    errorKind: ErrorKind | null;
    usage: Usage | null;
    ttftMs: number | null;
  },
): void {
  if (state.settled) return;
  state.settled = true;
  deps.telemetry.finish(state.record, {
    ...outcome,
    target: state.target,
    compression: state.compression,
  });
}

/**
 * Whether the client asked for a stream, read off the raw body.
 *
 * A structural check rather than a schema parse: the body has not been validated
 * yet when this runs, and the only thing wanted is a boolean for the row. A body
 * that is not an object, or has no `stream`, is not a stream — which is the
 * contract's own default.
 */
function wantsStream(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  return (body as { stream?: unknown }).stream === true;
}

/** The status an `AppError` would be answered with; 500 for anything else. */
function statusOf(error: unknown): number {
  return isAppError(error) ? error.status : 500;
}

function kindOf(error: unknown): ErrorKind {
  return isAppError(error) ? error.kind : 'internal';
}

/** The path suffix for a surface, for the row's `path`. */
function surfacePath(surface: ClientSurface): string {
  switch (surface) {
    case 'chat-completions':
      return 'chat/completions';
    case 'messages':
      return 'messages';
    case 'responses':
      return 'responses';
    case 'completions':
      return 'completions';
  }
}

function defaultRandom(bytes: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

/**
 * Say what was dropped, without touching the body (C5c).
 *
 * A header rather than a field in the payload, and the reason is the stream: an
 * SSE body is the provider's frames re-emitted, and inserting a frame of rutekit's
 * own would change a protocol the client's SDK is parsing. A header is outside
 * that — it is read before a single byte of body, works the same for a stream and
 * a JSON answer, and cannot be mistaken for the model's own words.
 *
 * The value is a comma-separated list in `CONTROL_ORDER`, so the same degradation
 * always reads the same way. `Response` copies its headers on construction, so
 * setting one here cannot disturb the body that is already flowing.
 */
function withDegradation(response: Response, dropped: readonly ControlKind[]): Response {
  if (dropped.length === 0) return response;
  response.headers.set('x-rutekit-degraded', dropped.join(','));
  return response;
}

/**
 * Phase 1 of the content filters, or a refusal (FR-11.3).
 *
 * A `block` rule raises `invalid_request` naming the rule rather than a
 * `permission`: the request is one rutekit will not carry, which is a statement
 * about the body, and a 403 on `/v1` reads to an SDK as a credential problem.
 * Naming the rule is what makes it actionable — an operator who wrote it sees
 * which one fired, and the client sees a refusal that explains itself.
 *
 * Nothing is called upstream, so a blocked turn costs no quota.
 *
 * Phase 2 is not here. It runs inside the call, after the pipeline, which is the
 * only place that knows what compression produced.
 */
function applyFilters(request: CanonicalRequest, deps: DispatcherDeps): CanonicalRequest {
  const outcome = applyPhase(request, deps.filters(), 1);
  if (outcome.kind === 'blocked') {
    throw AppError.invalidRequest(`This request was blocked by the rule "${outcome.rule.name}".`);
  }
  if (outcome.redactions > 0) {
    deps.logger.debug(
      { phase: 1, redactions: outcome.redactions },
      'content filters rewrote the request',
    );
  }
  return outcome.request;
}

function ingest(surface: ClientSurface, body: unknown): CanonicalRequest {
  try {
    return ingestRequest(surface, body);
  } catch (error) {
    throw AppError.invalidRequest(describe(error));
  }
}

function describe(error: unknown): string {
  const issues = (
    error as {
      issues?: readonly { path: readonly (string | number | symbol)[]; message: string }[];
    }
  ).issues;
  const first = issues?.[0];
  if (first === undefined) return 'The request body was not valid.';
  const path = first.path.join('.');
  return path === '' ? first.message : `${path}: ${first.message}`;
}

/**
 * The plan's candidates this key may use, best first.
 *
 * A key's model lists are matched against **both** names a candidate has: the id
 * the client sent and the real model id behind it. Denial beats allowance on
 * either, which is the direction that matters — without it, an operator who
 * denied `gpt-4o-mini` would be handing out an alias that reaches it, and the
 * denylist would be advice rather than a control.
 *
 * Filtering rather than refusing is what makes a combo useful under a restricted
 * key: an entry the key may not use is simply skipped, so a chain whose first
 * candidate is out of scope starts at the second.
 */
function permitted(plan: TurnPlan, key: ApiKeyRow, requested: string): RankedStep[] {
  return plan.steps.filter((step) => mayUse(key, requested, step.resolved.model.id));
}

function mayUse(key: ApiKeyRow, requested: string, resolvedId: string): boolean {
  if (key.modelsDenied.includes(requested) || key.modelsDenied.includes(resolvedId)) return false;
  if (key.modelsAllowed.length === 0) return true;
  return key.modelsAllowed.includes(requested) || key.modelsAllowed.includes(resolvedId);
}

function record(deps: DispatcherDeps, key: ApiKeyRow, usage: Usage | null): void {
  deps.apiKeys.recordUsage(key.id, {
    requests: 1,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  });
}
