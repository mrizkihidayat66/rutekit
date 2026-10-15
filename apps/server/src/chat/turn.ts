import type {
  CanonicalMessage,
  ErrorKind,
  ChatMessage,
  ChatMessageMeta,
  ChatSession,
  ChatTurnRequest,
  ContentBlock,
  ThinkingLevel,
} from '@contracts';
import type { CanonicalRequest, UiMessageRenderer, WireCodec } from '@translator';
import { canonicalRequestSchema, codecFor, createUiMessageStream } from '@translator';

import { AppError } from '@server/errors.ts';
import { demandsOf, isChatIncapable, unmetBy } from '@server/plan/capability.ts';
import type { ModelCatalog, ResolvedModel } from '@server/providers/model-catalog.ts';
import {
  NoAccountError,
  callModel,
  type CompressionReport,
  type ModelCallDeps,
} from '@server/providers/model-call.ts';
import type { TelemetryRecorder, TurnTarget } from '@server/telemetry/recorder.ts';
import { isAppError } from '@server/errors.ts';

import { attachmentBlocks } from './attachments.ts';
import { createReplyFold, type ReplyFold } from './reply.ts';
import type { ChatService } from './sessions.ts';
import { reasoningAsk } from './thinking.ts';

/**
 * One console chat turn, from the operator's keystroke to a streamed reply (C9).
 *
 * The second front door to `callModel`. `/v1` arrives with a model *name* and an
 * API key and asks the planner what that name means; this arrives with a provider
 * and a model the operator picked from a list, and has no key at all. Everything
 * after the choice — the lease, the Token Saver, the wire, the socket — is the
 * same call, which is the whole reason that core exists.
 *
 * **The conversation is read, not received.** The console sends one turn: what
 * was typed, and what was dropped onto it. The rest of the transcript comes from
 * the session's own rows, which is what makes a resumed chat identical to one
 * that never left the page, and why a turn's request body stays the same size
 * however long the conversation is. The turn is stored *before* the provider is
 * called, so a failed turn still leaves what the operator wrote.
 *
 * **The reply is folded back into blocks and stored when the stream ends.** A
 * stream is deltas and a transcript is blocks, so `reply.ts` accumulates one into
 * the other while the operator watches, and the fold is what the transcript keeps.
 * The write happens in `onStreamEnd`, which the pump calls *before* it closes the
 * body — a client that reads `[DONE]` and immediately re-fetches the session must
 * not find the reply missing from it.
 *
 * **A reply that produced nothing is not stored.** A provider that failed before
 * its first token left nothing on the screen, so there is nothing to remember; a
 * provider that failed *after* one left half an answer the operator read, and that
 * half is kept with `finishReason: 'error'` rather than thrown away. The console
 * already renders that as a failed turn, which is what it was.
 *
 * **Thinking is asked for in the provider's own vocabulary** (`thinking.ts`) and
 * gated by the model's declared capability, so a model that cannot think is asked
 * for nothing rather than sent a parameter it would reject.
 */

export interface ChatTurns {
  /** The streamed answer, ready to return. Throws an `AppError` for anything else. */
  run(sessionId: string, request: ChatTurnRequest, requestId: string | null): Promise<Response>;
}

export interface ChatTurnDeps {
  readonly chat: ChatService;
  /** Who serves a (provider, model) pair, and what wire to speak (C4.6). */
  readonly catalog: ModelCatalog;
  readonly call: ModelCallDeps;
  /**
   * Where a console turn is written down (FR-12.2–12.4).
   *
   * The second front door records telemetry for the same reason the first does,
   * and it did not until this was fixed: a console turn appeared in no request
   * log, in no usage chart, and its Token Saver savings were not counted at all —
   * the savings read model sums over `requests`, and a chat turn had no row.
   */
  readonly telemetry: TelemetryRecorder;
  /** Milliseconds, for the reply's own timings. Injectable so a test reads no clock. */
  readonly nowMs?: () => number;
  /** The id the `start` frame announces. Injectable so a test can assert it. */
  readonly newId?: () => string;
}

export function createChatTurns(deps: ChatTurnDeps): ChatTurns {
  const nowMs = deps.nowMs ?? ((): number => Date.now());
  const newId = deps.newId ?? ((): string => crypto.randomUUID());

  return {
    async run(
      sessionId: string,
      request: ChatTurnRequest,
      requestId: string | null,
    ): Promise<Response> {
      const session = deps.chat.get(sessionId);
      const target = resolveTarget(deps, session, request);

      // Opened before the attachment check below, so a turn refused for a bad
      // attachment is still a row an operator can find — the same reason the
      // dispatcher opens its own before the body is ingested.
      const record = deps.telemetry.begin({
        method: 'POST',
        path: '/console/api/chat/sessions/:id/messages',
        // The console is single-operator and holds a session cookie, not a key,
        // so there is no key to attribute the turn to.
        apiKeyId: null,
        streamed: true,
        requestId,
      });
      // Both are filled in as the turn proceeds — the account when a lease is
      // taken, the compression report before the call is sent — and the
      // `TurnTarget` is built from them at the end, because it is a readonly
      // record and this front door has no dispatcher loop to fill it in.
      let accountId: string | null = null;
      let compression: CompressionReport | null = null;
      const telemetryTarget = (): TurnTarget | null =>
        accountId === null
          ? null
          : {
              manifest: target.resolved.manifest,
              model: target.resolved.model.id,
              accountId,
              upstreamModel: target.resolved.upstreamId,
            };

      // The operator's own turn, captured before anything can refuse it — the
      // same rule the dispatcher follows, and for the same reason: a request that
      // failed validation is the one worth reading.
      deps.telemetry.capture(record, {
        stage: 'client_request',
        label: 'Console turn',
        body: request,
      });

      // Checked before anything is written. A turn the provider could never be
      // sent is not a turn, and finding that out after it is in the transcript
      // would leave the session permanently unable to answer — every later turn
      // rebuilds its request from the same attachments.
      attachmentBlocks(request.attachments);

      const turn = deps.chat.append(sessionId, request);
      const canonical = canonicalRequestOf(session, turn, target, request.thinkingLevel);
      const dropped = unmetBy(target.resolved.model.capabilities, demandsOf(canonical));

      const fold = createReplyFold();
      const renderer = createUiMessageStream({
        messageId: newId(),
        providerId: target.resolved.providerId,
        model: target.resolved.model.id,
        now: nowMs,
      });

      try {
        const result = await callModel(
          deps.call,
          canonical,
          {
            manifest: target.resolved.manifest,
            modelId: target.resolved.model.id,
            upstreamId: target.resolved.upstreamId,
            codec: target.codec,
            // The console's protocol is the AI SDK's, and it has no "the
            // provider's own bytes" route: every answer is re-rendered.
            direct: false,
            dropped,
          },
          { stream: () => tap(fold, renderer) },
          requestId,
          {
            // Named the moment the lease is taken, so a turn that fails after
            // this point still says which account it was sent as.
            onLease: (leased) => {
              accountId = leased;
            },
            onCompression: (report) => {
              compression = report;
            },
            onStreamEnd: (end) => {
              const meta = metaOf(renderer.metadata(), fold, end.ok);
              const content = fold.content().filter(meaningful);

              // The row is written whether or not there is a reply to store. A
              // turn that failed before its first token left nothing in the
              // transcript, and that is exactly the turn an operator opens the
              // request log to find — so the two are separate decisions, and the
              // early return that used to guard both is why a failed console turn
              // was invisible.
              deps.telemetry.finish(record, {
                status: end.ok ? 200 : statusOf(end.error),
                errorKind: end.ok ? null : kindOf(end.error),
                target: telemetryTarget(),
                usage: end.ok ? end.usage : null,
                ttftMs: meta.ttftMs,
                compression,
              });

              if (content.length === 0) return;
              deps.chat.append(
                sessionId,
                {
                  role: 'assistant',
                  content: [...content],
                  attachments: [],
                  parentMessageId: null,
                },
                meta,
              );
            },
          },
        );
        return result.response;
      } catch (error) {
        // A failure before the stream opened — no account, a refused lease, a
        // codec that could not encode. `onStreamEnd` never fires for these, so
        // the row is written here; without it the only console turns an operator
        // could see were the ones that worked.
        deps.telemetry.finish(record, {
          status: statusOf(error),
          errorKind: kindOf(error),
          target: telemetryTarget(),
          usage: null,
          ttftMs: null,
          compression,
        });

        // A busy pool is the one failure this front door has to translate. The
        // dispatcher reads it as "try the next candidate", and the console has no
        // next candidate — so here it is what it always was: every account this
        // provider has is taken. `unavailable` rather than `internal`, because
        // nothing is broken and the same turn may well work in a moment.
        if (error instanceof NoAccountError) throw AppError.unavailable(error.message);
        throw error;
      }
    },
  };
}

/** Which model answers, and in which dialect. */
interface Target {
  readonly resolved: ResolvedModel;
  readonly codec: WireCodec;
}

/**
 * The pair the operator chose, as a provider and a wire.
 *
 * The turn's own choices win over the session's, because the header is read at
 * send time: an operator who changed the model and pressed send means the model
 * they just picked. A session's stored pair is what the *next* turn starts from.
 *
 * `model` null is the console's "Provider default" placeholder, and it is refused
 * rather than guessed at — an aggregator's first model is not a default anybody
 * chose, and answering with it would put words in a model the operator did not
 * pick. The console's own empty state asks for a model before the first turn.
 */
function resolveTarget(deps: ChatTurnDeps, session: ChatSession, request: ChatTurnRequest): Target {
  const model = request.model ?? session.model;
  const providerId = request.providerId ?? session.providerId;

  if (model === null) {
    throw AppError.invalidRequest('Choose a model before sending a turn.');
  }

  const resolved = deps.catalog.resolve(model, providerId);
  if (resolved === null) {
    throw AppError.notFound(
      providerId === null
        ? `No provider serves the model ${model}.`
        : `No provider with id ${providerId} serves the model ${model}.`,
    );
  }
  if (isChatIncapable(resolved.model.capabilities)) {
    throw AppError.invalidRequest(
      `${resolved.model.id} cannot serve a chat turn; it is an embedding model.`,
    );
  }

  const codec = codecFor(resolved.family);
  if (codec === null) {
    throw AppError.invalidRequest(
      `${resolved.manifest.name} speaks a wire rutekit cannot translate.`,
    );
  }
  return { resolved, codec };
}

/**
 * The pivot request: the stored conversation, plus the turn that was just stored.
 *
 * The system prompt is hoisted the way the pivot wants it, and the reasoning ask
 * rides in `extras` where every codec spreads it into its own body.
 */
function canonicalRequestOf(
  session: ChatSession,
  turn: ChatMessage,
  target: Target,
  level: ThinkingLevel,
): CanonicalRequest {
  const ask = reasoningAsk(target.resolved.family, level);

  return canonicalRequestSchema.parse({
    model: target.resolved.model.id,
    system:
      session.systemPrompt === null || session.systemPrompt === ''
        ? []
        : [{ type: 'text', text: session.systemPrompt }],
    messages: [...session.messages, turn].map(toCanonicalMessage),
    ...(ask.maxTokens === null ? {} : { sampling: { maxTokens: ask.maxTokens } }),
    stream: true,
    extras: { ...ask.extras },
  });
}

/**
 * A stored turn as the pivot reads it.
 *
 * The attachments are folded in here rather than at storage time, because they
 * are two views of one turn: `attachments` is what the console renders as chips
 * beside the message, and the content array is what a model reads. Keeping the
 * stored content as the operator sent it means the transcript is a record of the
 * conversation rather than of the request it produced.
 */
function toCanonicalMessage(message: ChatMessage): CanonicalMessage {
  return {
    role: message.role,
    content: [...message.content, ...attachmentBlocks(message.attachments)],
    name: null,
    toolCallId: null,
  };
}

/**
 * The renderer the pump drives, with the fold watching alongside it.
 *
 * The renderer is a tap because it is the only thing that sees every canonical
 * event: the pump hands each one to it and keeps no copy. Passing the fold in
 * here is what lets the transcript be built from the same events the operator
 * watched, rather than from a second reading of the same stream.
 */
function tap(fold: ReplyFold, renderer: UiMessageRenderer): UiMessageRenderer {
  return {
    render(event) {
      fold.push(event);
      return renderer.render(event);
    },
    finish() {
      return renderer.finish();
    },
    metadata() {
      return renderer.metadata();
    },
  };
}

/**
 * Whether a block is worth storing.
 *
 * A block a provider opened and never filled is not content: a stream that began
 * a text block and died before a single token leaves `[{ type: 'text', text: '' }]`,
 * which renders as an empty turn and would be sent back to the model as one. A
 * tool call is kept whatever its arguments parsed to — the model called it.
 */
function meaningful(block: ContentBlock): boolean {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return block.text !== '';
    case 'tool_use':
      return true;
    case 'image':
    case 'tool_result':
      return false;
  }
}

/**
 * What the console records under a reply (FR-7.9).
 *
 * The finish reason comes from the fold rather than from the renderer's metadata,
 * because the two speak different vocabularies: the contract spells reasons with
 * underscores and the wire spells them with hyphens, and the stored record is the
 * contract's. A stream that failed before the provider said how it ended is
 * recorded as an error — which is the one reason the fold cannot report, since it
 * never arrived as an event.
 */
/**
 * The status a client received for a failure.
 *
 * Mirrors the dispatcher's own, and duplicated rather than shared because the
 * two differ in what they do with the result: the dispatcher writes its row from
 * a candidate loop that may have tried several, and this front door writes one
 * row for one attempt. Sharing the helper would mean sharing a file that owns a
 * loop this does not have.
 */
function statusOf(error: unknown): number {
  return isAppError(error) ? error.status : 500;
}

function kindOf(error: unknown): ErrorKind {
  return isAppError(error) ? error.kind : 'internal';
}

function metaOf(
  metadata: ReturnType<UiMessageRenderer['metadata']>,
  fold: ReplyFold,
  ok: boolean,
): ChatMessageMeta {
  return {
    ttftMs: metadata.ttftMs,
    totalMs: metadata.totalMs,
    tokensPerSecond: metadata.tokensPerSecond,
    usage: metadata.usage,
    finishReason: fold.finishReason() ?? (ok ? null : 'error'),
    providerId: metadata.providerId,
    model: metadata.model,
  };
}
