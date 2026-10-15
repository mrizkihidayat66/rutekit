import type { WorkerItem } from '@rutekit/contracts';

import {
  ItemAbandonedError,
  RetryableError,
  type BrowserDriver,
  type ImportContext,
  type ImportedAccount,
} from '../driver.ts';

/**
 * A driver that imports accounts without a browser (C7b).
 *
 * It exists so the whole job lifecycle — spawn, concurrency, retry, backoff, the
 * manual hand-off, abandonment, cancellation, the stdio protocol — can be driven
 * deterministically. Without it, every test of the orchestration would need a real
 * Chromium and a real provider, which is the definition of an untestable system.
 *
 * **The item's own text decides what happens**, rather than a script handed in
 * from outside. That is what lets the same driver be used in-process by a unit
 * test and over stdio by an integration test: the integration test cannot pass a
 * JavaScript object to a child process, but it can put a word in a credential
 * line. The vocabulary is small and explicit:
 *
 * | the credential contains | the driver does |
 * |---|---|
 * | `manual` | asks a human, then succeeds with the answer |
 * | `flaky` | fails retryably once, then succeeds |
 * | `slow` | takes a beat, so a cancellation has something to interrupt |
 * | `refuse` | fails in a way no retry can fix |
 * | anything else | succeeds on the first attempt |
 *
 * The `flaky` case needs to remember that it already failed once, so the driver
 * keeps a count per item. That is the one piece of state here, and it is what
 * makes "retry succeeds on the second attempt" assertable rather than a race.
 */

/** What a credential's text asks for. */
export type FakeBehaviour = 'manual' | 'flaky' | 'slow' | 'refuse' | 'plain';

export function behaviourOf(item: WorkerItem): FakeBehaviour {
  const text = `${item.label} ${item.credential ?? ''}`.toLowerCase();
  if (text.includes('manual')) return 'manual';
  if (text.includes('flaky')) return 'flaky';
  if (text.includes('slow')) return 'slow';
  if (text.includes('refuse')) return 'refuse';
  return 'plain';
}

export interface FakeDriverOptions {
  /** How long `slow` takes, so a test can interrupt it. */
  readonly slowMs?: number;
  /** The frame a `manual` item offers, as a data URL. */
  readonly manualFrameUrl?: string;
  /** Called for every step, so a test can watch the walk without the protocol. */
  readonly onStep?: (itemId: string, name: string) => void;
}

const DEFAULT_SLOW_MS = 5_000;
const DEFAULT_MANUAL_FRAME = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

export function createFakeDriver(options: FakeDriverOptions = {}): BrowserDriver {
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  /** How many times each item has been tried, so `flaky` can fail exactly once. */
  const attempts = new Map<string, number>();

  return {
    name: 'fake',

    async importItem(context: ImportContext): Promise<ImportedAccount> {
      const { item, signal, step, screenshot, askManual } = context;
      const behaviour = behaviourOf(item);
      const attempt = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, attempt);

      step('open', 'running');
      if (signal.aborted) throw new ItemAbandonedError();
      step('open', 'ok', 'the fake driver opened nothing, which is the point');

      if (behaviour === 'slow') {
        // Cancellation has to have something to interrupt, and a driver that
        // returned instantly would make every cancel test pass for the wrong
        // reason.
        await sleep(slowMs, signal);
      }

      if (behaviour === 'manual') {
        step('challenge', 'running', 'a challenge is in the way');
        screenshot({ frameUrl: options.manualFrameUrl ?? DEFAULT_MANUAL_FRAME, width: 320, height: 180 });
        const solution = await askManual('image challenge', options.manualFrameUrl ?? DEFAULT_MANUAL_FRAME);
        step('challenge', 'ok', `answered with "${solution}"`);
      }

      if (behaviour === 'refuse') {
        step('sign in', 'failed', 'the provider refused this credential');
        // Not retryable: a rejected credential is rejected again.
        throw new Error('the provider refused this credential');
      }

      if (behaviour === 'flaky' && attempt === 1) {
        step('sign in', 'failed', 'the page did not settle');
        // Retryable: this is the case the backoff loop exists for.
        throw new RetryableError('the page did not settle');
      }

      if (signal.aborted) throw new ItemAbandonedError();

      step('sign in', 'ok');
      options.onStep?.(item.id, 'sign in');
      step('collect', 'ok');

      return {
        credential: `fake-credential:${item.id}`,
        label: item.label,
      };
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** A sleep that a signal can cut short, so abandonment is not a wait to the end. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ItemAbandonedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ItemAbandonedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
