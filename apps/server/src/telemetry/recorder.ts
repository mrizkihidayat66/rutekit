import type { Logger } from 'pino';
import type { ErrorKind, RequestPayloadStage, Usage } from '@contracts';
import type { ProviderManifest } from '@registry';

import type { RequestsRepository, RequestRow } from '@server/persistence/requests.ts';
import type { CompressionReport } from '@server/providers/model-call.ts';

import { costOf } from './cost.ts';
import { redactPayload } from './redact.ts';
import { encodeSavings } from './savings.ts';

/**
 * Writing down what a turn did (C6, FR-12.2–12.4).
 *
 * One row per `/v1` turn, and the row is written **once, when the turn ends** —
 * success or failure, streamed or not. That is the only moment every column is
 * known: the status, the latency, the time to first token, and the usage the
 * provider reported (which for a stream arrives in the last frame, long after the
 * headers). A row written at the start would be a row that has to be updated, and
 * an updated row is one that can be left half-written by a crash.
 *
 * The recorder is **fail-open** in the R5.5 sense: a telemetry write that throws
 * must not turn a served request into a failed one. Every method swallows its own
 * errors into the log, because the operator asked for an answer, not for a chart.
 *
 * Payload capture is off by default and, when on, stores a **redacted** body with
 * a TTL (SEC-6). Both halves matter: the redaction is what keeps the inspector
 * from becoming a credential store, and the TTL is what keeps it from becoming
 * one later.
 */

/** A turn in flight, accumulating what only the end of it can know. */
export interface TurnRecord {
  readonly id: string;
  readonly requestId: string | null;
  readonly method: string;
  readonly path: string;
  readonly startedAtMs: number;
  readonly apiKeyId: string | null;
  readonly streamed: boolean;
}

/** The provider-side facts, known once a candidate is chosen. */
export interface TurnTarget {
  readonly manifest: ProviderManifest;
  readonly model: string;
  readonly accountId: string;
  readonly upstreamModel: string;
}

export interface CaptureRequest {
  readonly stage: RequestPayloadStage;
  readonly label: string;
  readonly body: unknown;
}

export interface TelemetryRecorder {
  /** Open a turn. Nothing is written yet; the returned record carries the clock. */
  begin(input: {
    method: string;
    path: string;
    apiKeyId: string | null;
    streamed: boolean;
    requestId: string | null;
  }): TurnRecord;
  /**
   * Record what a turn cost and how it ended.
   *
   * `status` is the HTTP status the client received, which is not always the
   * provider's: a turn that never reached one is still a 404 or a 403, and the
   * request log has to show it.
   */
  finish(
    turn: TurnRecord,
    outcome: {
      status: number;
      errorKind: ErrorKind | null;
      target: TurnTarget | null;
      usage: Usage | null;
      ttftMs: number | null;
      /**
       * What the Token Saver removed (C14), or null when it did not run.
       *
       * Part of the same write rather than a second one: the savings belong to
       * this turn, and a turn recorded in two statements is a turn that can be
       * half-recorded. See `telemetry/savings.ts` for why null and "saved
       * nothing" are different facts.
       */
      compression: CompressionReport | null;
    },
  ): void;
  /** Store a redacted body for the inspector. A no-op when capture is off. */
  capture(turn: TurnRecord, request: CaptureRequest): void;
  /** Delete telemetry past its retention and captures past their TTL. */
  sweep(): void;
}

export interface RecorderDeps {
  readonly requests: RequestsRepository;
  readonly logger: Logger;
  /** Whether payload capture is on (SEC-6). */
  readonly captureEnabled: () => boolean;
  readonly captureTtlMinutes: () => number;
  readonly retentionMinutes: () => number;
  /** Largest body to store, in bytes. Longer ones are truncated and flagged. */
  readonly maxCaptureBytes?: number;
  readonly now?: () => Date;
}

/** 256 KiB: a body bigger than this is not something a panel is read from. */
const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024;

export function createTelemetryRecorder(deps: RecorderDeps): TelemetryRecorder {
  const now = deps.now ?? ((): Date => new Date());
  const maxBytes = deps.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;

  return {
    begin(input): TurnRecord {
      return {
        id: crypto.randomUUID(),
        requestId: input.requestId,
        method: input.method,
        path: input.path,
        startedAtMs: Date.now(),
        apiKeyId: input.apiKeyId,
        streamed: input.streamed,
      };
    },

    finish(turn, outcome): void {
      try {
        const at = new Date(turn.startedAtMs).toISOString();
        const target = outcome.target;
        deps.requests.record({
          id: turn.id,
          at,
          method: turn.method,
          path: turn.path,
          providerId: target?.manifest.id ?? null,
          model: target?.model ?? null,
          accountId: target?.accountId ?? null,
          apiKeyId: turn.apiKeyId,
          status: outcome.status,
          errorKind: outcome.errorKind,
          latencyMs: Math.max(0, now().getTime() - turn.startedAtMs),
          ttftMs: outcome.ttftMs,
          inputTokens: outcome.usage?.inputTokens ?? null,
          outputTokens: outcome.usage?.outputTokens ?? null,
          cachedInputTokens: outcome.usage?.cachedInputTokens ?? null,
          reasoningTokens: outcome.usage?.reasoningTokens ?? null,
          // Priced against the model the provider actually served, which is not
          // always the id the client sent — a combo entry, or an upstream id.
          costUsd: costFor(target, outcome.usage),
          streamed: turn.streamed,
          requestId: turn.requestId,
          // Null when the Token Saver did not run, which is a fact the savings
          // read model needs to tell apart from "it ran and saved nothing".
          tokenSaverSavings:
            outcome.compression === null ? null : encodeSavings(outcome.compression),
        });
      } catch (error) {
        // Fail-open (R5.5): the answer the client is holding is not worth losing
        // over a row in a chart.
        deps.logger.warn({ err: error, requestId: turn.requestId }, 'telemetry write failed');
      }
    },

    capture(turn, request): void {
      if (!deps.captureEnabled()) return;
      try {
        const { value, redacted } = redactPayload(request.body);
        const encoded = JSON.stringify(value, null, 2);
        const bytes = new TextEncoder().encode(encoded);
        const truncated = bytes.byteLength > maxBytes;
        const body = truncated ? new TextDecoder().decode(bytes.slice(0, maxBytes)) : encoded;

        const at = now();
        deps.requests.saveCapture({
          id: crypto.randomUUID(),
          requestId: turn.id,
          stage: request.stage,
          body,
          byteSize: bytes.byteLength,
          truncated,
          redacted,
          capturedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + deps.captureTtlMinutes() * 60_000).toISOString(),
        });
      } catch (error) {
        deps.logger.warn({ err: error, requestId: turn.requestId }, 'payload capture failed');
      }
    },

    sweep(): void {
      try {
        const at = now();
        const requestsGone = deps.requests.deleteOlderThan(
          new Date(at.getTime() - deps.retentionMinutes() * 60_000).toISOString(),
        );
        const capturesGone = deps.requests.deleteExpiredCaptures(at.toISOString());
        if (requestsGone > 0 || capturesGone > 0) {
          deps.logger.debug({ requestsGone, capturesGone }, 'telemetry swept');
        }
      } catch (error) {
        deps.logger.warn({ err: error }, 'telemetry sweep failed');
      }
    },
  };
}

/** The price of a turn, or null when there is no model to price it against. */
function costFor(target: TurnTarget | null, usage: Usage | null): number | null {
  if (target === null || usage === null) return null;
  // The manifest model carries the price list; the id the client sent may be an
  // alias, so the lookup is by the id the provider itself was asked for.
  const model = target.manifest.models.find(
    (entry) => (entry.upstreamId ?? entry.id) === target.upstreamModel || entry.id === target.model,
  );
  return model === undefined ? null : costOf(model, usage);
}

/** The console's shape for one stored row, shared with the routes. */
export type { RequestRow };
