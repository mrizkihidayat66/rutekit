# `studio`

The image/video render queue and its storage (C10, ADR-0029).

## What it owns

The generation lifecycle — `queued → executing → progress → executed` — the file the
render produced, and the driver seam that talks to a media provider. Unlike the automation
worker, this queue runs **in-process**: a render needs an HTTP call and a websocket, no
browser and no CPU work on this side, so a subprocess would buy a stdio protocol and a
lifecycle for nothing.

## The files that matter

- **`queue.ts`** — `StudioQueue`: `submit`/`cancel`/`recover`/`inFlight`. Owns the
  concurrency cap, the timeout, and the coarse-grained progress writes.
- **`driver.ts`** — the `MediaDriver` seam, `MediaRequest`/`MediaProgress`/`MediaOutput`,
  and `RenderCancelledError`.
- **`drivers/comfyui.ts`** — the one real driver: builds the standard text-to-image graph
  and reads progress from ComfyUI's websocket.
- **`storage.ts`** — `AssetStorage`: where bytes live on disk, and the extension allowlist.
- **`catalog.ts`** — the read models (gallery, queue listing, asset bytes).
- **`socket.ts`** — the `MediaSocket` seam over the platform's `WebSocket`.

## Invariants and traps

- **The file path is built from an id rutekit minted and an allowlisted extension** —
  never anything a provider said. `storage.ts` refuses an unknown extension rather than
  passing it through, which is what makes `../` and drive letters inert.
- **The extension allowlist is a closed set** (`MEDIA_TYPES`), and the content type served
  back is derived from the same table. A new format is declared in a driver.
- **Cancel acts on the database for a `queued` job and aborts the controller for a running
  one.** Doing it the other way round would leave a window where a render the operator
  already stopped still starts.
- **Progress is written at a coarser grain than it is reported** (`PROGRESS_EPSILON`):
  thirty SQLite writes per render for a bar that moves two pixels is not worth it, but the
  terminal states are always written.
- **Concurrency is a cap, not a scheduler.** No priority, no fairness, no backpressure —
  a local ComfyUI serialises internally anyway.
- **A row left live by a dead process is recovered, not resumed** (`interruptLive`): the
  driver that owned it is gone and its handle is meaningless to a new process.
- **A local ComfyUI on `127.0.0.1` needs `RUTEKIT_EGRESS_ALLOWLIST`** — the egress guard
  refuses private addresses, which is the escape hatch working as designed, not a bug.
- **Video is refused by the ComfyUI driver.** The shipped graph covers the two image
  checkpoints; a video model needs a different graph, and declaring one per model is a
  manifest concern rather than something to fake here.
