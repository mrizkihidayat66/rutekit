# ADR-0017 — Dependency adoption for Chat, Benchmark, and Model Verification

Status: **Accepted** · Date: 2026-10-11 · Related decisions: FR-7.x, FR-9.x, FR-10.x

## Context

Four feature areas of `rutekit` need dedicated research because they cannot simply
imitate an existing implementation: Chat, Studio, multi-variant Benchmark, and model
authenticity verification. GitHub research was carried out and found adoption candidates
under varying licenses.

## Decision

### Chat

| Adoption                                     | License    | Role                                                            |
| -------------------------------------------- | ---------- | --------------------------------------------------------------- |
| `ai` + `@ai-sdk/react` (Vercel AI SDK)       | Apache-2.0 | Streaming transport, `useChat`, typed message parts             |
| `streamdown` (+ shiki/katex/mermaid plugins) | Apache-2.0 | Streaming-safe markdown renderer                                |
| `assistant-ui` (headless primitives)         | MIT        | `Thread`, `Message`, `Composer`, `ActionBar` — styled ourselves |
| `@lobehub/icons`                             | MIT        | Provider/model logos for the model picker                       |

**Important note:** the AI SDK is used on the **client side** as the transport. The backend
stays Hono per ADR-0003. There is no conflict.

### Benchmark

**`promptfoo`** (MIT) as the engine. Flow:

```
rutekit UI → generate promptfooconfig.yaml
           → spawn `promptfoo eval --output results.json`
           → parse JSON → render in the comparison UI
```

A thin streaming provider is written by hand to measure **TTFT** accurately, because
promptfoo's `latency` is total request latency, not TTFT.

### Model Verification

| Adoption                                                      | License | Role                                         |
| ------------------------------------------------------------- | ------- | -------------------------------------------- |
| Port of the JSD logic from `ToseaAI/llm-fingerprint-detector` | MIT     | Core signal: one-token output distribution   |
| Learn the fail-closed discipline from `llm-verify`            | MIT     | Minimum probes, banded verdict, INCONCLUSIVE |
| Learn tokenizer/error probes from `modelprint`                | MIT     | Cheap orthogonal signals                     |

**Patterns only (no code):**

- The 5-stage bazaarlink pipeline (reachability → family → model → twin → claim).
- The principle "never ask the endpoint its name".

## Consequences

**Positive**

- Chat: avoids implementing an SSE parser yourself (AP-10) and the half-finished
  markdown problem while streaming — the largest source of jank in a chat UI.
- Benchmark: `prompts × providers` is promptfoo's native model, exactly the
  "multi-variant template" need.
- Verification: one-token JSD is the current SOTA (~100 queries, ~7.3% EER), available
  in TypeScript under MIT — a direct fit for the `rutekit` stack.

**Negative / risks**

- Four new frontend dependencies for Chat (AI SDK, streamdown, assistant-ui, icons).
  Size needs checking; `assistant-ui` being headless means it imposes no styling.
- `promptfoo` runs as a separate process → it needs process management like the automation
  worker (ADR-0009).
- Model fingerprints **drift** over time and with quantization → baselines need refreshing.

## Mitigation

| Risk                         | Mitigation                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Chat bundle weight           | Lazy-load the Chat route; load it only when opened                                                                                     |
| promptfoo process management | The same pattern as the automation worker: spawn, stdio, timeout, kill                                                                 |
| A stale fingerprint baseline | Store the baseline as versioned data; provide a refresh command; verdicts are always banded and able to be INCONCLUSIVE (never binary) |
| Reliance on a single signal  | Multi-signal is mandatory: JSD + tokenizer + API surface + consistency checks                                                          |

## Explicitly Rejected

| Rejected                              | Reason                                 |
| ------------------------------------- | -------------------------------------- |
| open-webui, lobe-chat, chatbox (code) | Restrictive / GPL license              |
| open-webui, HF chat-ui (components)   | Svelte — not portable to React         |
| tldraw (code)                         | Paid production license                |
| ComfyUI (embed)                       | GPL-3.0 + a GPU ops burden             |
| A1111 (code)                          | AGPL-3.0 + Gradio                      |
| `llmperf`                             | Archived Dec 2025                      |
| `vivgrid/llm-fingerprinting`          | No license                             |
| `awesome-llm-copyright-protection`    | CC BY-NC (non-commercial)              |
| Recoil                                | Abandoned                              |
| polotno                               | Proprietary                            |
| A hand-rolled SSE parser              | The AI SDK already provides it (AP-10) |

## Binding Rules from This Decision

1. **Model verification must not report a binary verdict.** Always banded:
   `match` / `family-only` / `uncertain` / `mismatch` / `insufficient`.
2. **Self-identification is not evidence** — only a consistency check.
3. **Do not mix total latency with TTFT** on the Benchmark page.
4. **Video is not an image** — Studio uses asynchronous jobs from v1.
5. Every new dependency from this ADR is added to the approved list in
   [CONTRIBUTING §10.2](../plan/CONTRIBUTING.md).
