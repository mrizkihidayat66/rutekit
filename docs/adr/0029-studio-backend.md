# ADR-0029 — Studio: one real driver, in-process jobs, and files that cannot name a path

Status: **Accepted** · Date: 2026-10-14 · Related decisions: FR-8.1–8.6, ADR-0009, ADR-0019, ADR-0025

## Context

C10 is the backend for the Studio page: send a prompt, get an image or video. The roadmap
asks for four things — an async job abstraction (`submit → job_id → progress(event) →
asset URL`), an event vocabulary already fixed by the contract (`queued`, `executing`,
`progress`, `executed`, `failed`, `cancelled`), local asset storage, and a video pipeline.

Three things make C10 different from the previous groups.

**Media providers are the only corner of the catalog the translator cannot reach.** A
`/v1` turn is a _dialect_ problem: four wire families, one pivot. A render is not a
dialect. fal, replicate, Stability and ComfyUI have no shared request shape, no shared
progress protocol, and no shared idea of what a "result" is — a URL to poll, a base64
blob, or a file on the caller's disk. The pivot exists to unify four chat dialects; here
there is nothing to unify.

**A render is a job measured in minutes, not milliseconds.** Unlike a chat turn, which is
measured in seconds and can fail before a 200 goes out, a render outlives one HTTP
request and must survive the request that cancels it.

**A result file is data that comes from outside rutekit, and its name cannot be trusted.**
A filename from ComfyUI, from fal, or from anywhere else is a string chosen by another
party — and a string chosen by another party that ends up `join`ed into a path is how a
traversal happens.

## Decision

**One real driver with a seam for the rest; jobs run in-process; the queue holds the
deadline; files are named from ids rutekit prints itself; and the lineage the composer has
only been claiming is finally recorded.**

### 1. One real driver, and a refusal that names what is missing

`studio/driver.ts` is the seam: one interface (`generate(request, run)`) and one registry.
What fills it, for now, is one: **ComfyUI**.

ComfyUI was chosen not because it is the most popular, but because it is the only one that
**can be run for real without credentials**: its endpoint is HTTP, with no auth, its API is
four documented endpoints, and its event vocabulary is indeed this contract's vocabulary —
`queued → executing → progress → executed` in `asset.ts` is the ComfyUI prompt lifecycle. A
driver for a hosted endpoint is a translation; this one is a transcription.

Other media providers **refuse with a sentence that names itself and what would make it
work**:

```
400 invalid_request
"Fal has no media driver in rutekit yet, so it cannot render.
 Providers with one: comfyui-local."
```

`invalid_request` and not `unavailable`: nothing is down and retrying will not help — the
operator picked a provider rutekit cannot render, and the way out is to pick another one.

**The "write a driver for everything" alternative is rejected** because three drivers that
have never been run are three times the wrong surface, and two of them (fal, replicate)
need credentials that cannot be stored in this dev environment at all.

### 2. Jobs run in-process, not in a subprocess

Automation (C7) uses a Node subprocess because Playwright needs one. Media rendering does
not: what is needed is one HTTP call and one websocket — no browser, no CPU work on this
side. A subprocess here would buy the entire stdio protocol and lifecycle that must be
maintained, in exchange for zero useful isolation.

So the queue is an async task in the existing server. The consequence is stated, not
hidden: **a render in progress is lost when the process stops.** `studioQueue.recover()` is
called once at boot and marks every row still live as `failed` with a reason the operator
can read — the same choice C7b made for jobs found `running` after a restart. Nothing tries
to reconnect: the driver that owned it is gone, and its handle means nothing to a new
process.

**The "subprocess like C7" alternative is rejected** because consistency with automation is
not a good enough reason to add a protocol.

### 3. The deadline belongs to the queue, not the driver

Originally the timer was inside the ComfyUI driver. That was wrong, and a test found it: a
driver that hangs would hang its job forever, because only a driver that happens to
implement that clock has a clock.

Now the queue holds it: it aborts the `AbortController` when a render passes
`RUTEKIT_STUDIO_TIMEOUT_MS`, **and** races the driver's promise against that deadline — so
a driver that ignores the signal still cannot hang the queue. This is the same lesson C7b
named for the manual deadline: **the clock that cancels and the clock the console reads
must be one clock.**

**Cancel and timeout abort the same controller, but are not the same result.** The queue
keeps its own `cancelled` flag, because reading the signal alone cannot distinguish the
two — and reporting a timeout as a cancel tells the operator they stopped something they
did not stop.

**The timer is cleared on every exit path.** A render that finishes in two seconds must not
leave a timer firing for the full ceiling; at the fifteen-minute default with a busy
gallery, that is a pile of timers waiting to fire for nothing.

### 4. Files are named from an id rutekit prints, not from a name the provider gives

A `studio_assets` row stores an **extension**, not a `file_name`. The path is
`<dataDir>/studio/<asset id>.<extension>`.

This is a security property, not a style preference. The obvious design — store the
filename the provider returned, then `join` it to the directory — is how a provider (or a
manifest, or a model id) ends up naming a path. Here the id is a UUID rutekit prints and
the extension is checked against a closed list, so **no string from outside this process
can reach `..` or a drive letter.** A provider reporting `../../etc/passwd` gets an asset
whose extension is rejected, not a write outside the data directory.

The extension list is closed for the same reason: the console serves these bytes back with
a content type from that same table, so an unregistered extension would be served as
something it is not, or as an opaque download.

**The bytes are on disk, not in SQLite.** A five-second video is several megabytes, and
SQLite copies BLOBs through the page cache on every read.

**`thumbnailUrl` is always null, and that is a route decision, not a renderer decision.**
The file path serves the asset's own bytes, so a thumbnail would need a second entrance — a
query on this path, or its own path. Returning the same URL would tell the gallery a preview
exists and then hand over the full file, which is worse than saying there is none. The
`thumbnail_extension` column already exists for a driver that does produce a poster frame
(a video renderer), and the gallery already falls back to `url`.

### 5. The row is written before the file

When a render succeeds, its asset row is written first, then the bytes. A crash between the
two leaves **a registered asset with no bytes** — a broken image the console already knows
how to render, and whose file route answers 404 with a sentence saying the file is missing
from the data directory. The reverse order leaves **a file nothing points to**, an orphan
only a manual sweep would find.

Delete takes the same order, for the same reason: row first, file after.

### 6. Queue order is determined by `rowid`, and that is not cosmetic

`takeNext` orders by `created_at, rowid`. One batch is written in a single transaction with
a single timestamp, so **every job in it shares a `created_at` down to the millisecond** —
and without a second key, the order falls to whatever the query planner feels like, which
for a batch is a lottery on every read. SQLite's `rowid` is insertion order, which means
exactly "the order they were enqueued".

This was found by a test, not by reasoning: the cancel test assumed the first job of a batch
runs first, and failed because `takeNext` took the second.

### 7. Cancel has a REST route **and** a WS frame

The contract already declares `studio_cancel` over WebSocket. But the Studio page **has no
WS client at all** — it polls, like the other console pages. A console with no socket has no
way to send a frame, and a cancel button that cannot be pressed is not a feature.

So `POST /studio/generations/:id/cancel` was added to the contract, and the `studio_cancel`
frame **stays** for clients that do hold a socket. Both end at the same call, so the two
cannot disagree about what cancelling means.

That frame is also what gives `hub.onClientMessage` its first listener in this project —
until C10, `ack`, `job_control`, `manual_input` and `studio_cancel` were routed to an empty
listener list.

**Cancel works on the database, not on the driver.** A job still `queued` is cancelled by
writing its status — `takeNext` only ever takes `queued`, so a cancelled row is never taken.
A job already running is cancelled by abort. The reverse order — telling the driver to stop
and then recording it — would leave a window where a render the operator already stopped
still starts.

### 8. Progress is written more coarsely than it is reported

A thirty-step sampler sends thirty `progress` messages, and thirty SQLite writes per render
is a lot of I/O for a bar that moves two pixels. Writes are skipped unless the fraction
moves by ≥2% or the stage changes; terminal states are always written. The WS frame is
published after every write, so a pushed frame and a polled read never disagree.

### 9. Lineage is finally recorded

`studio.ts` in the frontend records this gap explicitly: "`studioGenerateBodySchema`
has no parent field, so the new job cannot record where it came from." The composer has
carried `origin` since FASE B and had nowhere to send it, so refine/variation/upscale could
only **claim** its lineage in a caption.

`Asset.parentAssetId` has existed in the contract since FASE B with nothing filling it. The
only thing missing was the entrance, so `parentAssetId` was added to
`studioGenerateBodySchema` and carried through to the asset row.

### 10. The ComfyUI graph is built by the driver, and video is refused

A ComfyUI render is a node graph. The driver sends one: a standard text-to-image pipeline —
checkpoint, two prompts, empty latent, sampler, decode, save — parameterized by the request.
**The model id is read as `ckpt_name`**, and that is not a liberty taken here: the
`comfyui-local` manifest registers `sd_xl_base_1.0.safetensors` and `flux1-dev.safetensors`,
which are files on the operator's disk, not model families.

**A video model is refused**, with a sentence naming the reason: `wan2.2_t2v_14B` needs a
graph with a text encoder, a VAE pair and a video save node, and guessing it would produce a
job that fails inside ComfyUI with a node error the operator cannot act on. The video
**pipeline** is still shipped in full — a video job goes through the same queue, with the
same progress, and lands as an asset with a `durationSeconds` the console player plays. What
is missing is the graph, and declaring a graph per model is the manifest's business — the
same shape of gap as Google's `thinkingConfig` in C9.

Progress comes from the ComfyUI websocket and nowhere else: `/history` only says whether a
prompt finished, never how far along it is. The driver opens the socket **before** submitting,
because ComfyUI starts broadcasting as soon as the prompt is queued — a socket connecting
afterwards would miss the first message, including, for a fast model, the one saying it is
already done.

Messages are filtered **per prompt id**, and that is not optional: a ComfyUI instance is
shared — the operator's own browser tab is quite possibly rendering at the same time — and
every client receives every client's messages. A driver that takes the first `executed` it
sees would hand one prompt's image to another prompt's job, which is a bug that looks like a
broken gallery.

### 11. Egress still applies, including for a local renderer

The driver uses the same fetcher as the rest of the server, so the egress guard applies to
media calls exactly as it does to chat calls. The consequence is stated plainly: **ComfyUI
at `127.0.0.1` is a private address, and the guard rejects private addresses unless the
operator allowlists it.** Running a local renderer means `RUTEKIT_EGRESS_ALLOWLIST=127.0.0.1/32`
— an escape hatch working as designed, not a bug. It is documented in `.env.example` next to
the key.

## Consequences

**Positive**

- FR-8.1 is genuinely achievable: one real media provider can render, and the others say why
  they cannot yet.
- A result file cannot name a path, and that is guarded by a test that tries to.
- Cancel and timeout are two different results, and the console sees the difference.
- A render cannot hang the queue, even if its driver ignores the signal.
- Refine/variation/upscale lineage is actually recorded.
- A job that died during a restart appears as `failed` with a readable reason, not as a row
  that looks like it is still working.

**Negative / risks**

- **No hosted media provider is usable.** fal, replicate and Stability refuse; only ComfyUI
  can render, and only if the operator has an instance. That is a deliberate boundary, not
  an oversight.
- **Video cannot be rendered at all.** The pipeline exists and is tested with a fake driver,
  but no real graph is sent, so FR-8.5 is not yet end-to-end.
- **The text-to-image graph is written by hand and applies only to SDXL and FLUX
  checkpoints.** A model needing different nodes (LoRA, ControlNet, upscale) cannot be
  expressed through `parameters` today.
- **No thumbnails.** The gallery loads the full file for every tile. For images that is
  correct and slightly heavier; for video it means broken tiles until `thumbnail_extension`
  is populated.
- **Progress is lost on restart.** A render that dies midway loses its percentage along with
  its job.
- **No budget or rate limit for renders.** A batch of eight consumes the operator's GPU with
  no bound other than `count` in the contract (maximum 8) and `RUTEKIT_STUDIO_CONCURRENCY`.
- **`queue.submit` stores parameters as-is.** An absurd value (steps 5000) reaches the
  renderer and comes back as a node error, not as a 400 from rutekit.
- **The gallery and queue are sorted in memory.** On an installation with tens of thousands
  of assets that will become a problem; right now it is not.

## Rejected alternatives

| Alternative                                                    | Reason for rejection                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A driver for every media provider now                          | Three drivers that cannot be run here are three times the wrong surface                    |
| A Node subprocess like C7                                      | Adds a stdio protocol for something that only needs one `fetch`                            |
| A seam only, with no real driver                               | An abstraction with no implementation: FR-8.1 would be achievable by nobody                |
| The deadline inside the driver                                 | A hanging driver hangs its job; a per-driver clock is a clock every driver has to remember |
| One result for cancel and timeout                              | Tells the operator they stopped something they did not stop                                |
| Not clearing the timer after a render finishes                 | At a 15-minute ceiling, a pile of timers waiting to fire for nothing                       |
| Storing the provider's `file_name`                             | A string from outside `join`ed to a path is how a traversal happens                        |
| Passing the extension through as-is                            | Served back with the wrong content type, or as an opaque download                          |
| Writing the file before the row                                | Leaves orphaned bytes that only a manual sweep finds                                       |
| Bytes in SQLite                                                | Multi-megabyte BLOBs copied through the page cache on every read                           |
| `thumbnailUrl` = `url`                                         | Tells the gallery a preview exists and then hands over the full file                       |
| `studio_cancel` WS only                                        | The Studio page polls and has no socket; a button that cannot be pressed is not a feature  |
| REST route only, WS frame removed                              | Removes something from a released contract, and push clients would have to add it back     |
| Ordering the queue by `created_at` only                        | A batch shares one timestamp, so the order is a lottery per read                           |
| Writing progress on every message                              | Thirty SQLite writes per render for a bar that moves two pixels                            |
| Guessing the video graph                                       | A job that fails inside ComfyUI with a node error the operator cannot act on               |
| Taking the first `executed` from the socket                    | The instance is shared; one prompt's image ends up in another prompt's job                 |
| Excluding the local renderer from egress                       | A security control with a hole shaped like "local address" is not a control                |
| Cancelling by telling the driver to stop and then recording it | A window where a render already stopped still starts                                       |
