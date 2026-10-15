import type { Logger } from 'pino';
import type { WsChannel, WsClientMessage, WsServerMessage } from '@contracts';
import { wsClientMessageSchema } from '@contracts';

import { AppError } from '@server/errors.ts';
import { HubConnection, type HubSocket } from './connection.ts';

/**
 * The single fan-out point for every real-time view (ADR-0012).
 *
 * One socket per client, many channels on it. A page subscribes to the channels
 * it is showing and unsubscribes on unmount, so an idle tab costs nothing and a
 * burst of preview frames only reaches the operator actually watching the
 * preview. The hub itself is deliberately ignorant of *what* it is carrying: it
 * routes by channel and stamps ordering, and the domain modules that own jobs,
 * accounts and studio register a listener for the client messages they care
 * about.
 */

/** Clients stop being pinged after this many missed heartbeats. */
const MISSED_HEARTBEATS_BEFORE_DROP = 3;
const CLOSE_GOING_AWAY = 1001;

export type ClientMessageHandler = (connectionId: string, message: WsClientMessage) => void;

export interface RealtimeHubOptions {
  /** Seconds the client should wait between pings; echoed in `hello`. */
  readonly heartbeatSeconds?: number;
  readonly now?: () => number;
}

export class RealtimeHub {
  readonly #connections = new Map<string, HubConnection>();
  readonly #listeners = new Set<ClientMessageHandler>();
  readonly #logger: Logger;
  readonly #heartbeatSeconds: number;
  readonly #now: () => number;
  #closing = false;

  constructor(logger: Logger, options: RealtimeHubOptions = {}) {
    this.#logger = logger;
    this.#heartbeatSeconds = options.heartbeatSeconds ?? 30;
    this.#now = options.now ?? Date.now;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get heartbeatSeconds(): number {
    return this.#heartbeatSeconds;
  }

  open(socket: HubSocket, connectionId: string = crypto.randomUUID()): HubConnection {
    const connection = new HubConnection(connectionId, socket, this.#now());
    this.#connections.set(connectionId, connection);
    connection.send({
      type: 'hello',
      connectionId,
      channels: [],
      heartbeatSeconds: this.#heartbeatSeconds,
      serverTimeUtc: new Date().toISOString(),
    });
    this.#logger.debug({ connectionId, connections: this.#connections.size }, 'ws connected');
    return connection;
  }

  close(connectionId: string, code = 1000, reason = 'bye'): void {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) return;
    this.#connections.delete(connectionId);
    try {
      connection.close(code, reason);
    } catch {
      // The peer may already be gone; the registry is the thing that matters.
    }
    this.#logger.debug({ connectionId, connections: this.#connections.size }, 'ws closed');
  }

  /**
   * Route one inbound frame. Parse failures answer with the same error envelope
   * the HTTP side uses, so a client has one error shape to handle (R5.9).
   */
  handleRaw(connectionId: string, raw: string | Uint8Array | ArrayBuffer): void {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) return;
    connection.touch(this.#now());

    let message: WsClientMessage;
    try {
      message = wsClientMessageSchema.parse(JSON.parse(decode(raw)));
    } catch (error) {
      this.#logger.debug({ connectionId, err: error }, 'ws frame rejected');
      const appError = AppError.invalidRequest('Unrecognised WebSocket frame.');
      connection.send({ type: 'error', error: appError.toApiError(null) });
      return;
    }

    switch (message.type) {
      case 'ping':
        connection.send({
          type: 'pong',
          echoAt: message.at,
          serverTimeUtc: new Date().toISOString(),
        });
        return;
      case 'subscribe':
        connection.subscribe(message.channels);
        this.#sendHello(connection);
        return;
      case 'unsubscribe':
        connection.unsubscribe(message.channels);
        this.#sendHello(connection);
        return;
      // ack / job_control / manual_input / studio_cancel belong to the domain
      // modules; C1 routes them and nothing more. Listed rather than left to a
      // `default`, so a channel added to the union is a compile error here.
      case 'ack':
      case 'job_control':
      case 'manual_input':
      case 'studio_cancel':
        for (const listener of this.#listeners) listener(connectionId, message);
    }
  }

  /** Deliver to every connection watching `channel`. Returns how many were reached. */
  publish(channel: WsChannel, message: WsServerMessage): number {
    let reached = 0;
    for (const connection of this.#connections.values()) {
      if (!connection.isSubscribedTo(channel)) continue;
      connection.send(message);
      reached += 1;
    }
    return reached;
  }

  /** Register a domain listener. Returns a function that removes it again. */
  onClientMessage(handler: ClientMessageHandler): () => void {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  /** Close connections that have gone quiet. Driven by a timer in the entrypoint. */
  sweep(): number {
    const cutoff = this.#now() - this.#heartbeatSeconds * MISSED_HEARTBEATS_BEFORE_DROP * 1000;
    let dropped = 0;
    for (const [id, connection] of this.#connections) {
      if (connection.lastSeenMs > cutoff) continue;
      dropped += 1;
      this.close(id, CLOSE_GOING_AWAY, 'heartbeat timeout');
    }
    return dropped;
  }

  /** Refuse new work and release everyone. Called on drain (A23). */
  closeAll(reason = 'server shutting down'): void {
    this.#closing = true;
    for (const id of [...this.#connections.keys()]) this.close(id, CLOSE_GOING_AWAY, reason);
    this.#listeners.clear();
  }

  get closing(): boolean {
    return this.#closing;
  }

  #sendHello(connection: HubConnection): void {
    connection.send({
      type: 'hello',
      connectionId: connection.id,
      channels: [...connection.channels],
      heartbeatSeconds: this.#heartbeatSeconds,
      serverTimeUtc: new Date().toISOString(),
    });
  }
}

function decode(raw: string | Uint8Array | ArrayBuffer): string {
  if (typeof raw === 'string') return raw;
  return new TextDecoder().decode(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
}
