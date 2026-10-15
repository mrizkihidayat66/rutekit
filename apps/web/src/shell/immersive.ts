/**
 * Whether the route on screen wants the shell's status bar out of the way.
 *
 * A chat is the one page in the console that is a *work surface* rather than a
 * readout: the transcript fills the window, the composer sits at its bottom, and
 * a clock ticking in the corner is 36 pixels of nothing. The ROADMAP calls this
 * an immersive route.
 *
 * It lives in a module rather than in React context because the two halves of it
 * are on opposite sides of the router: the page knows it is immersive and the
 * footer must find out, and threading a context through `AppShell` would mean
 * `AppShell` holding state for one of its twenty routes. A tiny subscription is
 * the smaller thing — and it keeps the footer's own render untouched, which is
 * the point: `Clock` re-renders once a second and nothing else should.
 *
 * Only ever one route is mounted, so a plain boolean is enough; a page that sets
 * it clears it on unmount and the footer comes back by itself.
 */

let immersive = false;
const listeners = new Set<() => void>();

export function setImmersive(next: boolean): void {
  if (immersive === next) return;
  immersive = next;
  for (const listener of listeners) listener();
}

export function subscribeImmersive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getImmersive(): boolean {
  return immersive;
}
