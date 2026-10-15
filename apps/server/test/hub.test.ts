import { describe, expect, it } from 'vitest';
import { apiErrorSchema, wsServerMessageSchema } from '@contracts';

import { silentLogger } from '@server/observability/logger.ts';
import type { HubSocket } from '@server/realtime/connection.ts';
import { RealtimeHub } from '@server/realtime/hub.ts';

/**
 * The fan-out point (C1.5, ADR-0012).
 *
 * The socket is a two-method recorder rather than a real WebSocket, which is the
 * whole reason `HubSocket` exists: every assertion here is on the frames a
 * client would have received, and none of them needs a server standing up.
 */

class FakeSocket implements HubSocket {
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Every frame, parsed. The envelope (`seq`, `at`) is spread alongside the body. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function makeHub(now: () => number = Date.now): RealtimeHub {
  return new RealtimeHub(silentLogger(), { heartbeatSeconds: 30, now });
}

describe('RealtimeHub', () => {
  it('greets a new connection with a hello naming it', () => {
    const hub = makeHub();
    const socket = new FakeSocket();

    hub.open(socket, 'conn-1');

    expect(hub.connectionCount).toBe(1);
    const [hello] = socket.frames();
    expect(hello).toMatchObject({
      type: 'hello',
      connectionId: 'conn-1',
      channels: [],
      heartbeatSeconds: 30,
    });
    expect(hello?.seq).toBe(1);
    expect(hello?.at).toBeTypeOf('string');
    // Every frame the hub emits is a valid server message, envelope included.
    expect(() => wsServerMessageSchema.parse(hello)).not.toThrow();
  });

  it('answers a ping with a pong echoing the client clock', () => {
    const hub = makeHub();
    const socket = new FakeSocket();
    hub.open(socket, 'c');
    socket.sent.length = 0;

    const at = '2026-10-13T00:00:00.000Z';
    hub.handleRaw('c', JSON.stringify({ type: 'ping', at }));

    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    // The sequence keeps counting across the cleared hello, so it is asserted
    // only as present — the echo is what this test is about.
    expect(frames[0]).toMatchObject({ type: 'pong', echoAt: at });
    expect(frames[0]?.seq).toBeTypeOf('number');
  });

  it('confirms a subscribe with a hello listing the accepted channels', () => {
    const hub = makeHub();
    const socket = new FakeSocket();
    const connection = hub.open(socket, 'c');
    socket.sent.length = 0;

    hub.handleRaw('c', JSON.stringify({ type: 'subscribe', channels: ['logs', 'jobs'] }));

    const [hello] = socket.frames();
    expect(hello).toMatchObject({ type: 'hello', channels: ['logs', 'jobs'] });
    expect(connection.isSubscribedTo('logs')).toBe(true);
    expect(connection.isSubscribedTo('preview')).toBe(false);
  });

  it('removes channels on unsubscribe', () => {
    const hub = makeHub();
    const socket = new FakeSocket();
    const connection = hub.open(socket, 'c');

    hub.handleRaw('c', JSON.stringify({ type: 'subscribe', channels: ['logs', 'jobs'] }));
    hub.handleRaw('c', JSON.stringify({ type: 'unsubscribe', channels: ['logs'] }));

    expect(connection.channels).toEqual(['jobs']);
    const frames = socket.frames();
    expect(frames.at(-1)).toMatchObject({ type: 'hello', channels: ['jobs'] });
  });

  it('answers a malformed frame with the same error envelope the HTTP side uses', () => {
    const hub = makeHub();
    const socket = new FakeSocket();
    hub.open(socket, 'c');
    socket.sent.length = 0;

    expect(() => hub.handleRaw('c', 'not json at all')).not.toThrow();
    expect(() => hub.handleRaw('c', JSON.stringify({ type: 'nonsense' }))).not.toThrow();

    const frames = socket.frames();
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.type).toBe('error');
      expect(() => apiErrorSchema.parse(frame.error)).not.toThrow();
    }
  });

  it('ignores a frame from a connection it does not know', () => {
    const hub = makeHub();
    expect(() => hub.handleRaw('ghost', JSON.stringify({ type: 'ping', at: 'x' }))).not.toThrow();
  });

  it('delivers a publish only to subscribers, and reports how many', () => {
    const hub = makeHub();
    const watcher = new FakeSocket();
    const other = new FakeSocket();
    hub.open(watcher, 'w');
    hub.open(other, 'o');
    hub.handleRaw('w', JSON.stringify({ type: 'subscribe', channels: ['jobs'] }));
    watcher.sent.length = 0;
    other.sent.length = 0;

    const reached = hub.publish('jobs', {
      type: 'job_update',
      job: {} as never,
    });

    expect(reached).toBe(1);
    expect(watcher.frames()).toHaveLength(1);
    expect(other.frames()).toHaveLength(0);
  });

  it('reaches nobody when a channel has no subscribers', () => {
    const hub = makeHub();
    hub.open(new FakeSocket(), 'c');
    expect(hub.publish('preview', { type: 'system_status', status: {} as never })).toBe(0);
  });

  it('hands domain messages to listeners instead of routing them itself', () => {
    const hub = makeHub();
    const socket = new FakeSocket();
    hub.open(socket, 'c');
    socket.sent.length = 0; // drop the opening hello
    const seen: string[] = [];
    hub.onClientMessage((id, message) => {
      seen.push(`${id}:${message.type}`);
    });

    hub.handleRaw('c', JSON.stringify({ type: 'job_control', jobId: 'j1', action: 'pause' }));

    expect(seen).toEqual(['c:job_control']);
    // A listener that only observes must not also produce a reply.
    expect(socket.frames()).toEqual([]);
  });

  it('stops delivering to a listener once it is removed', () => {
    const hub = makeHub();
    hub.open(new FakeSocket(), 'c');
    let calls = 0;
    const off = hub.onClientMessage(() => {
      calls += 1;
    });

    hub.handleRaw('c', JSON.stringify({ type: 'ack', ids: ['n1'] }));
    off();
    hub.handleRaw('c', JSON.stringify({ type: 'ack', ids: ['n2'] }));

    expect(calls).toBe(1);
  });

  it('drops connections that have missed too many heartbeats', () => {
    let clock = 0;
    const hub = makeHub(() => clock);
    const socket = new FakeSocket();
    hub.open(socket, 'c');

    // Two heartbeat intervals is not yet enough to drop.
    clock = 60_000;
    expect(hub.sweep()).toBe(0);
    expect(hub.connectionCount).toBe(1);

    // Past three, the connection is gone and was closed politely.
    clock = 91_000;
    expect(hub.sweep()).toBe(1);
    expect(hub.connectionCount).toBe(0);
    expect(socket.closed?.code).toBe(1001);
  });

  it('keeps a connection alive while it keeps sending', () => {
    let clock = 0;
    const hub = makeHub(() => clock);
    const socket = new FakeSocket();
    hub.open(socket, 'c');

    clock = 80_000;
    hub.handleRaw('c', JSON.stringify({ type: 'ping', at: '2026-10-13T00:00:00.000Z' }));
    clock = 150_000; // 70s since the last frame: still under the cutoff

    expect(hub.sweep()).toBe(0);
    expect(hub.connectionCount).toBe(1);
  });

  it('closes every connection and refuses more on closeAll', () => {
    const hub = makeHub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.open(a, 'a');
    hub.open(b, 'b');

    hub.closeAll();

    expect(hub.connectionCount).toBe(0);
    expect(hub.closing).toBe(true);
    expect(a.closed?.code).toBe(1001);
    expect(b.closed?.code).toBe(1001);
  });

  it('forgets a connection on close', () => {
    const hub = makeHub();
    const socket = new FakeSocket();
    hub.open(socket, 'c');

    hub.close('c', 1000, 'bye');

    expect(hub.connectionCount).toBe(0);
    expect(socket.closed).toEqual({ code: 1000, reason: 'bye' });
  });
});
