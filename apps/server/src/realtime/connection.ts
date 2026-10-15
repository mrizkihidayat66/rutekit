import type { WsChannel, WsEnvelope, WsServerMessage } from '@contracts';

/**
 * One client, as the hub sees it.
 *
 * The socket is held behind a two-method interface rather than the runtime's own
 * type, so a test can hand in a recorder and assert on the frames a client would
 * have received without standing up a server.
 */
export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class HubConnection {
  readonly id: string;
  readonly #socket: HubSocket;
  readonly #channels = new Set<WsChannel>();
  /** Per-connection, monotonic: the client's ordering and gap signal (ADR-0012). */
  #seq = 0;
  #lastSeenMs: number;

  constructor(id: string, socket: HubSocket, nowMs: number) {
    this.id = id;
    this.#socket = socket;
    this.#lastSeenMs = nowMs;
  }

  get channels(): readonly WsChannel[] {
    return [...this.#channels];
  }

  get lastSeenMs(): number {
    return this.#lastSeenMs;
  }

  touch(nowMs: number): void {
    this.#lastSeenMs = nowMs;
  }

  isSubscribedTo(channel: WsChannel): boolean {
    return this.#channels.has(channel);
  }

  subscribe(channels: readonly WsChannel[]): void {
    for (const channel of channels) this.#channels.add(channel);
  }

  unsubscribe(channels: readonly WsChannel[]): void {
    for (const channel of channels) this.#channels.delete(channel);
  }

  /** The envelope is stamped here, so every frame on this socket is ordered. */
  send(message: WsServerMessage): void {
    this.#seq += 1;
    const envelope: WsEnvelope = { seq: this.#seq, at: new Date().toISOString() };
    this.#socket.send(JSON.stringify({ ...message, ...envelope }));
  }

  close(code = 1000, reason = 'bye'): void {
    this.#socket.close(code, reason);
  }
}
