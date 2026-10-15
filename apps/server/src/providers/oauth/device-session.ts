import type { Fetcher } from '@registry';

import { pollDeviceToken } from './device.ts';
import type { OauthToken } from './wire.ts';

/**
 * The device sign-in, kept alive between requests (C3b2).
 *
 * The browser flow has somewhere to come back to: the provider redirects to the
 * callback and the flow ends inside that request. The device flow has nowhere —
 * the operator is on a different machine, typing a code into the provider's own
 * page — and the console's contract has no endpoint to poll, only one to start.
 * So the polling has to live here, on a timer, between the request that began the
 * sign-in and the one that finds the account already there.
 *
 * A session is owned by the provider, not by the state: two sign-ins for one
 * provider are the same sign-in as far as the console is concerned, and starting
 * a second abandons the first rather than leaving two pollers racing to write the
 * same account. Every session ends in exactly one way — a token, a failure, or
 * the provider's own expiry — and `stopAll` ends the rest at shutdown, so the
 * timer never outlives the process that owns it.
 */

/** Schedule one run, and hand back the way to cancel it. */
export type Scheduler = (run: () => void, delayMs: number) => () => void;

const SLOW_DOWN_EXTRA_SECONDS = 5;

const defaultScheduler: Scheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  // A sign-in nobody finishes is not a reason for the process to stay up.
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};

export interface DeviceSessionRequest {
  readonly providerId: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly deviceCode: string;
  readonly intervalSeconds: number;
  /** The provider's own deadline for the code; the poll stops there, not before. */
  readonly expiresAtMs: number;
  readonly fetch: Fetcher;
  readonly now: () => number;
  readonly onToken: (token: OauthToken) => void;
  readonly onFailure: (message: string) => void;
}

export interface DeviceSessions {
  /** Begin polling, abandoning any session already running for this provider. */
  start(request: DeviceSessionRequest): void;
  stop(providerId: string): void;
  stopAll(): void;
  readonly size: number;
}

export interface DeviceSessionsOptions {
  readonly schedule?: Scheduler;
}

export function createDeviceSessions(options: DeviceSessionsOptions = {}): DeviceSessions {
  const schedule = options.schedule ?? defaultScheduler;
  const cancels = new Map<string, () => void>();

  function stop(providerId: string): void {
    const cancel = cancels.get(providerId);
    if (cancel === undefined) return;
    cancels.delete(providerId);
    cancel();
  }

  function scheduleNext(request: DeviceSessionRequest, seconds: number): void {
    cancels.set(
      request.providerId,
      schedule(() => {
        poll(request);
      }, seconds * 1000),
    );
  }

  function poll(request: DeviceSessionRequest): void {
    // The timer that fired this poll is spent; a new one replaces it below, and
    // until then the session is deliberately absent from the map so that an
    // in-flight request cannot be cancelled twice.
    cancels.delete(request.providerId);

    if (request.now() >= request.expiresAtMs) {
      request.onFailure('The sign-in code expired before it was approved.');
      return;
    }

    void pollDeviceToken({
      tokenUrl: request.tokenUrl,
      clientId: request.clientId,
      deviceCode: request.deviceCode,
      fetch: request.fetch,
      now: request.now,
    }).then((result) => {
      switch (result.status) {
        case 'token':
          request.onToken(result.token);
          return;
        case 'pending':
          scheduleNext(request, request.intervalSeconds);
          return;
        case 'slow_down':
          scheduleNext(request, request.intervalSeconds + SLOW_DOWN_EXTRA_SECONDS);
          return;
        case 'failed':
          request.onFailure(result.message);
          return;
      }
    });
  }

  return {
    start(request: DeviceSessionRequest): void {
      stop(request.providerId);
      scheduleNext(request, request.intervalSeconds);
    },

    stop,

    stopAll(): void {
      for (const cancel of cancels.values()) cancel();
      cancels.clear();
    },

    get size(): number {
      return cancels.size;
    },
  };
}
