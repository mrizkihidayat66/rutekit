/**
 * The one socket a media driver needs, behind a seam (C10).
 *
 * ComfyUI reports progress over a WebSocket and nowhere else: `/history` says
 * only whether a prompt is finished, so a console that polled HTTP would show a
 * bar that sits at zero and then jumps to done. The socket is therefore the only
 * way to get a moving progress bar out of a local renderer.
 *
 * It is a seam rather than a direct `new WebSocket(...)` for the reason every
 * other outbound call in this server is: a test has to be able to drive the
 * messages. A driver whose progress path can only be exercised against a real
 * ComfyUI install is a progress path that is never exercised.
 *
 * The interface is deliberately four methods. A driver wants to open, to be told
 * what arrived, to be told when it ended, and to close — anything richer would be
 * a WebSocket API re-declared with different names, and the wrapper below already
 * is the whole of the translation.
 */

export interface MediaSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
}

export type MediaSocketFactory = (url: string) => MediaSocket;

/**
 * The platform's own WebSocket, adapted.
 *
 * `Bun` and Node both expose a global `WebSocket` whose message event carries
 * either a string or a `Blob` depending on the frame; ComfyUI sends text, and a
 * binary frame is not something this protocol has, so a non-string is ignored
 * rather than decoded. An ignored frame is a frame that was never part of the
 * conversation, which is the honest reading.
 */
export const globalMediaSocket: MediaSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send(data: string): void {
      socket.send(data);
    },
    close(): void {
      socket.close();
    },
    onMessage(handler: (data: string) => void): void {
      socket.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data === 'string') handler(event.data);
      });
    },
    onClose(handler: () => void): void {
      socket.addEventListener('close', () => {
        handler();
      });
    },
    onError(handler: (error: unknown) => void): void {
      socket.addEventListener('error', (event: Event) => {
        handler(event);
      });
    },
  };
};
