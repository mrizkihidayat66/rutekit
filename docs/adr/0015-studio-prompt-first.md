# ADR-0015 — Studio page: prompt-first + gallery (not a canvas editor)

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D16

## Context

The Studio page must let users generate images and videos from a prompt
after selecting a vision-capable model. GitHub research found three distinct UX models:

| Model                      | Example                     | Effort    | Fit                                                        |
| -------------------------- | --------------------------- | --------- | ---------------------------------------------------------- |
| **Canva-like canvas**      | tldraw, Konva, fabric.js    | Very high | A multi-object whiteboard — not the "prompt → result" flow |
| **Node editor**            | ComfyUI, `@xyflow/react`    | High      | Technical; a power-user audience, not a general one        |
| **Prompt-first + gallery** | Fooocus, InvokeAI (gallery) | Medium    | Exactly the generation flow; easy to outgrow               |

An important research finding: **choosing a canvas library before defining the editing
model** is a trap. A whiteboard (Excalidraw/tldraw) is fundamentally different from a
layered editor, and video compositing/mask/overlay needs to be validated first.

## Decision

**Prompt-first + gallery** for v1. The canvas editor and node editor are deferred to v2.

```
┌──────────────────────────────────────────────────────────┐
│ Sidebar (280px)     │  Main                              │
│                     │                                    │
│ [Provider ▾]        │  ┌──────────────────────────────┐  │
│ [Model ▾]           │  │ Prompt textarea              │  │
│                     │  │                              │  │
│ Parameters          │  │ [Generate]                   │  │
│  steps      [ 20 ]  │  └──────────────────────────────┘  │
│  size    [1024² ▾]  │                                    │
│  guidance   [ 7.0 ] │  Gallery (grid, infinite scroll)   │
│  seed    [ random ] │  ┌────┐┌────┐┌────┐┌────┐         │
│                     │  │    ││    ││    ││    │         │
│ [x] Image           │  └────┘└────┘└────┘└────┘         │
│ [ ] Video           │                                    │
└─────────────────────┴────────────────────────────────────┘
```

### Detail view (clicking a result)

```
Fullsize asset (image / video player)
Metadata: prompt · seed · model · steps · guidance · size · time · cost
Actions:  [Download] [Refine] [Upscale] [Variation] [Remix prompt]
```

### Asynchronous job abstraction (adopted from ComfyUI's vocabulary)

```
submit(prompt, params) → job_id
  → progress: queued → executing → progress% → executed
  → asset URL
```

Terminal states: `executed` | `failed` | `cancelled`.

## Consequences

**Positive**

- The generation flow is immediately usable from v1 — real value without waiting for a canvas system.
- No canvas library dependency in v1 → a smaller bundle, less risk.
- A gallery with full metadata (the InvokeAI pattern) enables one-click recall/remix,
  which is precisely the most frequently used feature.
- An asynchronous job structure from the start → **video is not made a second-class citizen**
  (avoiding the trap of "treating video like an image").

**Negative / risks**

- No canvas editing (mask, layer, text) in v1 — users have to leave for another tool.
- Going beyond "prompt → result" requires v2.

## Upgrade path

| Version | Addition                                        | Library rationale                   |
| ------- | ----------------------------------------------- | ----------------------------------- |
| v1      | Prompt-first + gallery + video job              | No canvas library                   |
| v1.5    | Mask-based inpaint/outpaint + upscale           | `react-konva` (MIT, React 19-ready) |
| v2      | Visual pipeline mode (optional, power user)     | `@xyflow/react` (MIT)               |
| v2.5    | Full layered editor (text overlay, compositing) | `react-konva`                       |

## Validation before v2.5

Before committing to a layered editor, validate: layer compositing, mask export,
video overlay fidelity. This is an explicit message from the research.

## Rejected alternatives

| Alternative                    | Reason for rejection                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| A canvas editor from the start | Very high effort; not the core "generate from a prompt" flow; research warns against choosing a canvas library before the editing model |
| tldraw as the foundation       | Excellent UX, but a **paid production license** and its model is a whiteboard, not a layered raster editor                              |
| Excalidraw                     | A whiteboard with no layer panel — the wrong model                                                                                      |
| Embedding ComfyUI              | GPL-3.0 + a GPU ops burden + a fast-moving frontend; the router already faces cloud providers                                           |
| A node editor as the main UI   | Too technical for the general generation flow                                                                                           |
