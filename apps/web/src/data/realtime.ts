import {
  wsServerMessageSchema,
  type WsChannel,
  type WsClientMessage,
  type WsServerMessage,
} from '@contracts';

/**
 * The console's one WebSocket, and the only place it is opened (ADR-0012).
 *
 * **This file existed as an absence until now.** The server has published frames
 * on the `preview` channel since FASE C — the worker screenshots its page, the
 * job manager forwards it, the hub fans it out — and nothing on this side ever
 * connected, so the live preview had no image in it. The gap was invisible
 * because every other automation view polls, and a polled view looks the same
 * whether or not a socket is also open.
 *
 * **One socket, many channels.** The contract's design is that a page subscribes
 * to what it is showing and unsubscribes when it unmounts, so an idle tab costs
 * nothing and a burst of preview frames only reaches the operator actually
 * watching a preview. That is why this is a module-level connection with a
 * subscriber registry rather than a socket per component: two components watching
 * two channels must share one connection, and the server counts connections.
 *
 * **It reconnects, because the alternative is a pane that quietly stops.** The
 * server drops a connection after three missed heartbeats, a dev server restarts
 * on every edit, and a laptop sleeps. A preview that silently freezes is worse
 * than one that says it is reconnecting, so a dropped socket is retried with a
 * backoff and every channel is re-subscribed on the way back up.
 *
 * **Nothing is dispatched unvalidated.** Every inbound frame is parsed against the
 * contract, and one that does not fit is dropped rather than handed to a
 * component as a plausible-looking object — the same rule the HTTP client follows.
 */

/**
 * The minimum of `WebSocket` this needs, so a test can hand in a recorder.
 *
 * The handler properties carry the DOM's own event types rather than a trimmed
 * `() => void`, because a real `WebSocket` has to satisfy this interface and its
 * handlers all take an event — and a signature that drops the argument is not one
 * a real socket can be assigned to. The implementation ignores every argument but
 * `message.data`, which is the part that is actually read.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** `WebSocket.OPEN`. Named because the constant is not on the interface above. */
const OPEN = 1;

/**
 * Which channel carries which message.
 *
 * A complete map rather than a lookup with a fallback: a message type added to
 * the contract should be a compile error here, because the failure mode of
 * forgetting is a frame that is published, received, and handed to nobody.
 */
const CHANNEL_OF: Record<WsServerMessage['type'], WsChannel | null> = {
  preview_frame: 'preview',
  job_update: 'jobs',
  job_step: 'jobs',
  job_needs_manual: 'jobs',
  log_append: 'logs',
  account_update: 'accounts',
  studio_progress: 'studio',
  notification: 'notifications',
  system_status: 'system',
  // Connection-level frames are answered by this module, not routed to a channel.
  hello: null,
  pong: null,
  error: null,
};

/** First retry delay, doubling to `RECONNECT_MAX_MS` on each failure. */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;

/** Until `hello` says otherwise. The server's own default, mirrored. */
const DEFAULT_HEARTBEAT_SECONDS = 30;

type Handler = (message: WsServerMessage) => void;

/** The socket URL for this page, or null where there is no origin to build one. */
function defaultSocketUrl(): string | null {
  if (typeof location === 'undefined' || location.host === '') return null;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // A relative path on purpose: in development Vite proxies `/ws` (with
  // `ws: true`), and in production the server that serves this bundle is the one
  // that owns the socket, so both are the current origin.
  return `${scheme}//${location.host}/ws`;
}

function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url);
}

export class RealtimeClient {
  readonly #create: SocketFactory;
  readonly #url: () => string | null;
  readonly #subscribers = new Map<WsChannel, Set<Handler>>();
  #socket: SocketLike | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatSeconds = DEFAULT_HEARTBEAT_SECONDS;
  #attempts = 0;
  /** Set once the client is disposed; stops a reconnect from resurrecting it. */
  #disposed = false;

  constructor(options: { create?: SocketFactory; url?: () => string | null } = {}) {
    this.#create = options.create ?? defaultSocketFactory;
    this.#url = options.url ?? defaultSocketUrl;
  }

  /** Whether a socket is currently open. For tests and for a status indicator. */
  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === OPEN;
  }

  /**
   * Watch a channel. Returns the unsubscribe.
   *
   * Connecting is deferred to the first subscriber, so a page that watches
   * nothing opens nothing — which is the whole reason the contract is built
   * around channels rather than around one firehose.
   */
  subscribe(channel: WsChannel, handler: Handler): () => void {
    let handlers = this.#subscribers.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      this.#subscribers.set(channel, handlers);
      // A channel nobody was watching has to be told to the server — but only if
      // the socket is already open, and the check comes *before* the connect
      // below. A socket that is still connecting asks for everything in the
      // registry the moment it opens, so asking here too would be a frame the
      // open handler repeats. The repetition would be harmless — the server's
      // subscribe is a set insertion — but sending it is still work with no
      // purpose, and reading the two cases as one is how the open handler's
      // contract gets forgotten.
      if (this.connected) this.#sendSubscribe([channel]);
    }
    handlers.add(handler);

    this.#ensureConnected();

    return () => {
      const current = this.#subscribers.get(channel);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size > 0) return;

      this.#subscribers.delete(channel);
      this.#send({ type: 'unsubscribe', channels: [channel] });
      // No channels left means no reason to hold a socket, and the server counts
      // connections against a limit. Closing is what makes an idle tab free.
      if (this.#subscribers.size === 0) this.#teardown();
    };
  }

  /** Close everything. For a test's `afterEach`, and for a deliberate shutdown. */
  dispose(): void {
    this.#disposed = true;
    this.#subscribers.clear();
    this.#teardown();
  }

  #ensureConnected(): void {
    if (this.#disposed || this.#socket !== null) return;
    const url = this.#url();
    if (url === null) return;

    const socket = this.#create(url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempts = 0;
      this.#sendSubscribe([...this.#subscribers.keys()]);
    };
    socket.onmessage = (event) => {
      this.#receive(event.data);
    };
    socket.onclose = () => {
      this.#onClosed();
    };
    // `onerror` is followed by `onclose` in every browser, so the retry lives
    // there. Handled anyway so a socket that only errors does not go silent.
    socket.onerror = () => {
      this.#onClosed();
    };
  }

  #onClosed(): void {
    this.#teardown();
    // Still wanted? Try again, unless nobody is watching or we were disposed.
    if (this.#disposed || this.#subscribers.size === 0) return;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** this.#attempts, RECONNECT_MAX_MS);
    this.#attempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#ensureConnected();
    }, delay);
  }

  /** Drop the socket and its timers without changing what is being watched. */
  #teardown(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Already gone; the reference being dropped is what matters.
    }
  }

  #send(message: WsClientMessage): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A send on a socket that closed between the check and the call. The close
      // handler is what recovers; there is nothing to report here.
    }
  }

  #sendSubscribe(channels: readonly WsChannel[]): void {
    if (channels.length === 0) return;
    this.#send({ type: 'subscribe', channels: [...channels] });
  }

  #receive(raw: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }

    const parsed = wsServerMessageSchema.safeParse(frame);
    if (!parsed.success) return;
    const message = parsed.data;

    // The heartbeat interval is the server's to choose, and it says so on connect
    // and again after every subscribe. Restarting on each is what keeps the two
    // ends in step when the server's value changes under us.
    if (message.type === 'hello') {
      this.#heartbeatSeconds = message.heartbeatSeconds;
      this.#startHeartbeat();
      return;
    }
    if (message.type === 'pong') return;

    const channel = CHANNEL_OF[message.type];
    if (channel === null) return;
    for (const handler of this.#subscribers.get(channel) ?? []) handler(message);
  }

  /**
   * Ping on the server's own interval.
   *
   * The hub closes a connection after three missed heartbeats, so a client that
   * never pings is dropped within a minute and a half — and a preview that is
   * dropped is a preview that stops updating with no error to show for it.
   */
  #startHeartbeat(): void {
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
    const everyMs = this.#heartbeatSeconds * 1000;
    this.#heartbeatTimer = setInterval(() => {
      this.#send({ type: 'ping', at: new Date().toISOString() });
    }, everyMs);
  }
}

/**
 * The console's connection.
 *
 * A module-level instance because the socket is a property of the page, not of a
 * component: two panes watching two channels must share it, and unmounting one
 * must not close the other's.
 */
export const realtime = new RealtimeClient();
