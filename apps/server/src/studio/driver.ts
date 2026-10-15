import type { AssetKind } from '@contracts';

import { AppError } from '@server/errors.ts';

/**
 * How rutekit asks a provider to make a picture (C10, FR-8.1–8.5).
 *
 * The media providers are the one corner of the catalogue the translator cannot
 * reach. A `/v1` turn is a *dialect* problem — four wire families, one pivot — but
 * a render is not a dialect: fal, replicate, Stability and ComfyUI have no common
 * request shape, no common progress protocol, and no common idea of what a result
 * even is (a URL to poll, a base64 blob, a file on the caller's own disk). The
 * pivot exists to make four chat dialects into one; there is nothing here to
 * unify, so this is a seam instead.
 *
 * **The seam is the same shape C7c used for browser flows**, and for the same
 * reason: one interface, one real implementation, and an honest refusal for
 * everything else. A provider with no driver refuses with a sentence naming what
 * is missing rather than a 500 from a half-written adapter — and the refusal is
 * the signal that a provider needs a driver of its own.
 *
 * **A driver owns its protocol, not its transport.** It is handed the fetcher the
 * rest of the server uses, so the egress guard applies to a media call exactly as
 * it applies to a chat call. That has a consequence worth stating plainly: a
 * ComfyUI instance on `127.0.0.1` is a private address, and the guard refuses
 * private addresses unless the operator allowlists them. Running a local renderer
 * therefore means `RUTEKIT_EGRESS_ALLOWLIST=127.0.0.1/32`, which is the escape
 * hatch working as designed rather than a bug.
 *
 * **Progress is a callback, not a stream.** A driver reports movement while it
 * works and resolves with the file when it is done; the queue is what turns those
 * callbacks into rows and socket frames. Keeping the driver free of both is what
 * lets it be tested by calling `generate` and reading the answer.
 */

/** One render, as the driver receives it. */
export interface MediaRequest {
  readonly kind: AssetKind;
  /**
   * The model id as the manifest spells it.
   *
   * For a local runner that id is often the thing itself — ComfyUI's catalogue
   * lists checkpoint filenames, not model families — so a driver is free to read
   * it as a filename, a slug, or a model name, because the manifest is what
   * decided which.
   */
  readonly model: string;
  readonly prompt: string;
  readonly negativePrompt: string | null;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
}

/** How far along a render is, as the driver can tell. */
export interface MediaProgress {
  /** 0–1, or null when the provider reports no fraction. */
  readonly progress: number | null;
  /** A short human label: what the renderer is doing right now. */
  readonly stage: string | null;
}

/** The file a render produced. */
export interface MediaOutput {
  /** Without the dot. Checked against the storage allowlist, not trusted. */
  readonly extension: string;
  readonly bytes: Uint8Array;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
}

/** What the driver is given to report with, and to stop with. */
export interface MediaRun {
  readonly onProgress: (progress: MediaProgress) => void;
  /** Aborted when the operator cancels. A driver must not resolve after this fires. */
  readonly signal: AbortSignal;
}

export interface MediaDriver {
  /** The manifest id this driver serves. One driver per provider, for now. */
  readonly providerId: string;
  /**
   * Run one render.
   *
   * Resolves with the file, or throws. A driver that cannot serve a request —
   * an unknown model, a format it cannot build — throws rather than resolving
   * with a placeholder, because a job that "succeeded" with nothing in it is a
   * gallery tile that lies.
   */
  generate(request: MediaRequest, run: MediaRun): Promise<MediaOutput>;
}

/**
 * The operator stopped this render.
 *
 * Its own type rather than an `AppError`, because a cancel is not a failure and
 * must not reach a client as one: the queue turns it into the job's `cancelled`
 * status and stops there. `AppError.aborted` would have been the tempting
 * spelling, but that kind exists for a client disconnecting mid-request — a
 * different event with a different meaning, and the 499 it maps to belongs to
 * the request that went away, not to the render that was stopped.
 */
export class RenderCancelledError extends Error {
  constructor() {
    super('The render was cancelled.');
    this.name = 'RenderCancelledError';
  }
}

/** Which driver serves which provider. */
export interface MediaDrivers {
  for(providerId: string): MediaDriver | null;
  /** The provider ids that have one, for the console's capability list. */
  served(): readonly string[];
}

export interface MediaDriversDeps {
  readonly drivers: readonly MediaDriver[];
}

export function createMediaDrivers(deps: MediaDriversDeps): MediaDrivers {
  const byProvider = new Map(deps.drivers.map((driver) => [driver.providerId, driver]));
  return {
    for(providerId: string): MediaDriver | null {
      return byProvider.get(providerId) ?? null;
    },
    served(): readonly string[] {
      return [...byProvider.keys()].sort();
    },
  };
}

/**
 * The refusal a provider without a driver gets.
 *
 * An `invalid_request` rather than an `unavailable`: nothing is down and retrying
 * will not help — the operator picked a provider rutekit cannot render with, and
 * the fix is to pick another one. The message names the provider so a console can
 * show it beside the model picker, and says what would change it, because "not
 * supported" with no next step is a dead end.
 */
export function noMediaDriver(providerName: string, served: readonly string[]): AppError {
  const known =
    served.length === 0
      ? 'No media provider has a driver yet.'
      : `Providers with one: ${served.join(', ')}.`;
  return AppError.invalidRequest(
    `${providerName} has no media driver in rutekit yet, so it cannot render. ${known}`,
  );
}
