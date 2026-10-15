import type { MediaDriver, MediaOutput, MediaRequest } from '@server/studio/driver.ts';
import { RenderCancelledError } from '@server/studio/driver.ts';

/**
 * A media driver a test can steer (C10).
 *
 * The only shipped driver is ComfyUI's, and it wants a real instance on the
 * operator's machine — so without this, every test of the queue, the asset
 * storage and the routes would be a test of nothing. It is a file of its own
 * because two suites need it: the queue's own tests and the route tests, which
 * have to reach the same driver through the composition root.
 */

/** A one-pixel PNG's magic bytes: real enough to be written, read and served. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface FakeMediaDriver extends MediaDriver {
  /** Every request the queue sent, so a test can assert what was asked for. */
  readonly requests: MediaRequest[];
}

export interface FakeMediaOptions {
  readonly providerId?: string;
  /** How many progress callbacks to emit before resolving. */
  readonly steps?: number;
  readonly extension?: string;
  readonly bytes?: Uint8Array;
  /** Fail with this message instead of producing a file. */
  readonly fail?: string;
  /** Never resolve. The only way out is the abort a cancel or a deadline sends. */
  readonly hang?: boolean;
  /** Refuse a kind, standing in for a driver that cannot render it. */
  readonly refuseVideo?: string;
}

export function fakeMediaDriver(options: FakeMediaOptions = {}): FakeMediaDriver {
  const requests: MediaRequest[] = [];
  const steps = options.steps ?? 2;

  return {
    providerId: options.providerId ?? 'comfyui-local',
    requests,

    async generate(request, run): Promise<MediaOutput> {
      requests.push(request);
      if (options.refuseVideo !== undefined && request.kind === 'video') {
        throw new Error(options.refuseVideo);
      }
      if (options.fail !== undefined) throw new Error(options.fail);

      for (let step = 1; step <= steps; step += 1) {
        run.onProgress({ progress: step / steps, stage: 'Sampling' });
      }

      if (options.hang === true) {
        await new Promise<void>((_resolve, reject) => {
          run.signal.addEventListener(
            'abort',
            () => {
              reject(new RenderCancelledError());
            },
            { once: true },
          );
        });
      }

      return {
        extension: options.extension ?? 'png',
        bytes: options.bytes ?? PNG_BYTES,
        width: null,
        height: null,
        durationSeconds: null,
      };
    },
  };
}
