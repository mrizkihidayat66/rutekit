import { describe, expect, it } from 'vitest';
import { hostToWorkerSchema, workerToHostSchema } from '@rutekit/contracts';

/**
 * The stdio protocol (C7b, ADR-0009, R1.7).
 *
 * The host and the worker are two runtimes, so the only thing keeping them in
 * step is that both validate every frame against the same schema. These tests
 * pin what the schemas accept and — more importantly — what they refuse, because
 * a frame that parses into something plausible is the failure mode this boundary
 * exists to prevent: a field that reads as `undefined` and drives the wrong
 * branch, in a process the server cannot debug.
 */

const START = {
  type: 'start',
  workerId: 'w1',
  job: {
    jobId: 'j1',
    providerId: 'kiro',
    method: 'bulk-login',
    engine: 'chromium',
    mode: 'headless',
    concurrency: 2,
    maxAttempts: 3,
    automation: {
      login: 'browser',
      startUrl: 'https://example.com/signin',
      captcha: true,
      humanTimeoutSeconds: 180,
    },
    proxy: { url: 'http://1.2.3.4:8080' },
    sms: null,
    items: [{ id: 'i1', label: 'a***@example.com', credential: 'a:pw' }],
  },
};

describe('what the host sends', () => {
  it('accepts a fully resolved job', () => {
    const parsed = hostToWorkerSchema.safeParse(START);
    expect(parsed.success).toBe(true);
  });

  it('accepts a token import, which opens no browser', () => {
    const parsed = hostToWorkerSchema.safeParse({
      ...START,
      job: {
        ...START.job,
        method: 'bulk-token',
        engine: null,
        mode: null,
        automation: null,
        proxy: null,
        items: [{ id: 'i1', label: 'eyJ•••', credential: 'access:refresh' }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('defaults the nullable job fields rather than requiring them', () => {
    // A job is stored and read back without knowing which method produced it, so
    // the browser fields are nullable rather than absent — and a frame that
    // leaves one out entirely must still parse.
    const { automation, proxy, sms, ...job } = START.job;
    void automation;
    void proxy;
    void sms;
    const parsed = hostToWorkerSchema.safeParse({ type: 'start', workerId: 'w1', job });
    expect(parsed.success).toBe(true);
  });

  it('refuses an item with no id', () => {
    const parsed = hostToWorkerSchema.safeParse({
      ...START,
      job: { ...START.job, items: [{ label: 'a***@example.com', credential: 'a:pw' }] },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a method the contract does not describe', () => {
    const parsed = hostToWorkerSchema.safeParse({
      ...START,
      job: { ...START.job, method: 'bulk-whatever' },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an engine it does not have', () => {
    const parsed = hostToWorkerSchema.safeParse({
      ...START,
      job: { ...START.job, engine: 'webkit' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts each of the four control frames', () => {
    for (const frame of [
      { type: 'cancel', workerId: 'w1' },
      { type: 'shutdown', workerId: 'w1' },
      { type: 'manual-answer', workerId: 'w1', itemId: 'i1', solution: 'AB12C' },
      { type: 'abandon-item', workerId: 'w1', itemId: 'i1' },
    ]) {
      expect(hostToWorkerSchema.safeParse(frame).success, frame.type).toBe(true);
    }
  });

  it('refuses a frame with no type at all', () => {
    expect(hostToWorkerSchema.safeParse({ workerId: 'w1' }).success).toBe(false);
  });
});

describe('what the worker sends', () => {
  it('accepts a ready frame', () => {
    expect(workerToHostSchema.safeParse({ type: 'ready', workerId: 'w1' }).success).toBe(true);
  });

  it('accepts a step with and without a detail', () => {
    expect(
      workerToHostSchema.safeParse({
        type: 'step',
        workerId: 'w1',
        itemId: 'i1',
        index: 0,
        name: 'open',
        status: 'running',
      }).success,
    ).toBe(true);
    expect(
      workerToHostSchema.safeParse({
        type: 'step',
        workerId: 'w1',
        itemId: 'i1',
        index: 0,
        name: 'open',
        status: 'ok',
        detail: 'the page settled',
      }).success,
    ).toBe(true);
  });

  it('refuses a step status the console has no tab for', () => {
    const parsed = workerToHostSchema.safeParse({
      type: 'step',
      workerId: 'w1',
      itemId: 'i1',
      index: 0,
      name: 'open',
      status: 'maybe',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a needs-manual frame and defaults its screenshot', () => {
    const parsed = workerToHostSchema.safeParse({
      type: 'needs-manual',
      workerId: 'w1',
      itemId: 'i1',
      reason: 'image challenge',
      humanTimeoutSeconds: 180,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The screenshot is optional because a challenge with nothing to look at is
    // still a challenge — the reason is what the operator acts on.
    expect(parsed.data.type === 'needs-manual' && parsed.data.screenshotUrl).toBeNull();
  });

  it('accepts a screenshot with no item, which is a job between items', () => {
    const parsed = workerToHostSchema.safeParse({
      type: 'screenshot',
      workerId: 'w1',
      frameUrl: 'data:image/jpeg;base64,AAAA',
      width: 320,
      height: 180,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type === 'screenshot' && parsed.data.itemId).toBeNull();
  });

  it('carries the credential an item produced', () => {
    const parsed = workerToHostSchema.safeParse({
      type: 'item-done',
      workerId: 'w1',
      itemId: 'i1',
      credential: 'sk-live-abc',
      label: 'a***@example.com',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an item-done with no credential', () => {
    // An import that produced nothing is a failure, and letting it parse as a
    // success would store an empty account.
    const parsed = workerToHostSchema.safeParse({
      type: 'item-done',
      workerId: 'w1',
      itemId: 'i1',
      label: 'a***@example.com',
    });
    expect(parsed.success).toBe(false);
  });

  it('carries whether a job-level failure is retryable', () => {
    const parsed = workerToHostSchema.safeParse({
      type: 'failed',
      workerId: 'w1',
      error: 'no browser is installed',
      retryable: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a job-level failure with no retryable verdict', () => {
    // The verdict is what the console offers a Retry on, so guessing it would be
    // guessing whether the operator's next click is worth making.
    const parsed = workerToHostSchema.safeParse({
      type: 'failed',
      workerId: 'w1',
      error: 'no browser is installed',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a host frame on the worker’s side of the protocol', () => {
    // The two unions are disjoint, which is what makes a crossed wire a parse
    // failure rather than a frame that reads as something else.
    expect(workerToHostSchema.safeParse({ type: 'start', workerId: 'w1', job: {} }).success).toBe(
      false,
    );
    expect(hostToWorkerSchema.safeParse({ type: 'ready', workerId: 'w1' }).success).toBe(false);
  });
});
