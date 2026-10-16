import { afterEach, describe, expect, it, vi } from 'vitest';

import { RealtimeClient, type SocketLike } from './realtime.ts';

/**
 * The console's WebSocket, against a recorder rather than a server.
 *
 * What this file is for is the client's own decisions, which are the ones that go
 * wrong quietly: does it connect once for two channels, does it re-subscribe
 * after a drop, does it stop when nobody is watching, and does it refuse a frame
 * that does not match the contract. A socket that half-works looks exactly like a
 * feature that was never built, which is how the live preview came to be missing
 * a client in the first place.
 */

/**
 * A socket that records what it was sent and can be driven by hand.
 *
 * It starts `CONNECTING`, like a real one, rather than already open: that is the
 * state a client is in between asking for a socket and being told it is up.
 */
class Recorder implements SocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** Everything this socket was asked to send, parsed. */
  frames(): { type?: string; channels?: string[] }[] {
    return this.sent.map((entry) => JSON.parse(entry) as { type?: string; channels?: string[] });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
}

const sockets: Recorder[] = [];

function client(url = 'ws://test/ws'): { client: RealtimeClient; socket: () => Recorder } {
  const realtime = new RealtimeClient({
    url: () => url,
    create: () => {
      const socket = new Recorder();
      sockets.push(socket);
      return socket;
    },
  });
  return {
    client: realtime,
    socket: () => {
      const last = sockets.at(-1);
      if (last === undefined) throw new Error('no socket was created');
      return last;
    },
  };
}

afterEach(() => {
  sockets.length = 0;
  vi.useRealTimers();
});

describe('connecting', () => {
  it('opens nothing until something is watched', () => {
    const { client: realtime } = client();
    expect(sockets).toHaveLength(0);
    realtime.dispose();
  });

  it('shares one socket between two channels', () => {
    const { client: realtime, socket } = client();
    const offJobs = realtime.subscribe('jobs', () => undefined);
    const offPreview = realtime.subscribe('preview', () => undefined);

    expect(sockets).toHaveLength(1);
    // Nothing was written before the socket was up. This is a weaker assertion
    // than it looks and is kept for what it does say rather than what it seems
    // to: the client also refuses to write to a socket that is not open, so a
    // version that subscribed too early would be masked by that guard and this
    // check would not fail. What it does catch is a client that writes to a
    // socket it never opened.
    expect(socket().frames()).toEqual([]);

    socket().open();
    // Both channels are asked for on open, in one frame rather than two.
    expect(socket().frames()).toEqual([{ type: 'subscribe', channels: ['jobs', 'preview'] }]);

    offJobs();
    offPreview();
    realtime.dispose();
  });

  it('subscribes a channel added after the socket is already up', () => {
    const { client: realtime, socket } = client();
    const offJobs = realtime.subscribe('jobs', () => undefined);
    socket().open();

    const offPreview = realtime.subscribe('preview', () => undefined);
    expect(socket().frames().at(-1)).toEqual({ type: 'subscribe', channels: ['preview'] });

    offJobs();
    offPreview();
    realtime.dispose();
  });
});

describe('unsubscribing', () => {
  it('tells the server, and closes when the last watcher leaves', () => {
    const { client: realtime, socket } = client();
    const off = realtime.subscribe('preview', () => undefined);
    socket().open();

    off();
    expect(socket().frames().at(-1)).toEqual({ type: 'unsubscribe', channels: ['preview'] });
    // Nobody is watching, so the socket goes: the server counts connections, and
    // an idle tab is meant to cost nothing.
    expect(socket().closed).toBe(true);

    realtime.dispose();
  });

  it('keeps the socket while another channel is still watched', () => {
    const { client: realtime, socket } = client();
    const offJobs = realtime.subscribe('jobs', () => undefined);
    const offPreview = realtime.subscribe('preview', () => undefined);
    socket().open();

    offPreview();
    expect(socket().closed).toBe(false);

    offJobs();
    realtime.dispose();
  });
});

describe('delivering frames', () => {
  it('routes a frame to its channel and not to the other', () => {
    const { client: realtime, socket } = client();
    const onJobs = vi.fn();
    const onPreview = vi.fn();
    const offJobs = realtime.subscribe('jobs', onJobs);
    const offPreview = realtime.subscribe('preview', onPreview);
    socket().open();

    socket().deliver({
      type: 'preview_frame',
      jobId: 'j1',
      workerId: 'w1',
      frameUrl: 'data:image/jpeg;base64,AAAA',
      width: 1280,
      height: 720,
      capturedAt: '2026-10-17T00:00:00.000Z',
      seq: 1,
      at: '2026-10-17T00:00:00.000Z',
    });

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onJobs).not.toHaveBeenCalled();

    offJobs();
    offPreview();
    realtime.dispose();
  });

  it('drops a frame that does not match the contract', () => {
    const { client: realtime, socket } = client();
    const onPreview = vi.fn();
    const off = realtime.subscribe('preview', onPreview);
    socket().open();

    // No `frameUrl`, no dimensions: a plausible-looking object that is not one.
    socket().deliver({ type: 'preview_frame', jobId: 'j1', workerId: 'w1' });
    // And something that is not JSON at all.
    socket().onmessage?.({ data: 'not json' } as MessageEvent);

    expect(onPreview).not.toHaveBeenCalled();

    off();
    realtime.dispose();
  });

  it('answers a hello with a heartbeat and does not route it to a channel', () => {
    vi.useFakeTimers();
    const { client: realtime, socket } = client();
    const onJobs = vi.fn();
    const off = realtime.subscribe('jobs', onJobs);
    socket().open();

    socket().deliver({
      type: 'hello',
      connectionId: 'c1',
      channels: ['jobs'],
      heartbeatSeconds: 30,
      serverTimeUtc: '2026-10-17T00:00:00.000Z',
      seq: 1,
      at: '2026-10-17T00:00:00.000Z',
    });

    expect(onJobs).not.toHaveBeenCalled();

    // The hub drops a connection after three missed heartbeats, so a client that
    // never pings is a preview that stops updating with nothing to show for it.
    vi.advanceTimersByTime(30_000);
    expect(socket().frames().filter((frame) => frame.type === 'ping')).toHaveLength(1);

    off();
    realtime.dispose();
  });
});

describe('reconnecting', () => {
  it('re-subscribes what was being watched after a drop', () => {
    vi.useFakeTimers();
    const { client: realtime, socket } = client();
    const off = realtime.subscribe('preview', () => undefined);
    socket().open();
    expect(sockets).toHaveLength(1);

    socket().drop();
    vi.advanceTimersByTime(1_000);

    // A second socket, and the channel it was watching is asked for again —
    // otherwise the pane comes back to a socket that carries nothing.
    expect(sockets).toHaveLength(2);
    const reconnected = sockets.at(-1);
    reconnected?.open();
    expect(reconnected?.frames()).toEqual([{ type: 'subscribe', channels: ['preview'] }]);

    off();
    realtime.dispose();
  });

  it('does not reconnect once nobody is watching', () => {
    vi.useFakeTimers();
    const { client: realtime, socket } = client();
    const off = realtime.subscribe('preview', () => undefined);
    socket().open();

    off();
    socket().drop();
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
    realtime.dispose();
  });

  it('backs off further on each attempt', () => {
    vi.useFakeTimers();
    const { client: realtime, socket } = client();
    const off = realtime.subscribe('preview', () => undefined);
    socket().open();

    // First drop: retried at 500ms.
    socket().drop();
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // Second drop without a successful open: retried at 1000ms, not 500.
    sockets.at(-1)?.drop();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(3);

    off();
    realtime.dispose();
  });

  it('stops for good after dispose', () => {
    vi.useFakeTimers();
    const { client: realtime, socket } = client();
    realtime.subscribe('preview', () => undefined);
    socket().open();

    realtime.dispose();
    socket().drop();
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
  });
});
