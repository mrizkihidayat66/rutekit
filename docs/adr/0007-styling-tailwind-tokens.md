# ADR-0007 — Styling: Tailwind CSS 4 + CSS custom properties

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D7, D14

## Context

This space has one recurring inherited problem: **Tailwind and
bespoke CSS living side by side with no clear boundary** — a landing page using
utilities, a console using ~4,000 lines of semantic CSS — plus a lot of inline
`style={{}}` in TSX. Mixing utilities with inline styles is a common pattern in the same
space. Alternatively, pure CSS Modules (no Tailwind) is the cleanest architecturally but
slows prototyping and multiplies the number of files.

## Decision

**Tailwind CSS 4 as the substrate + CSS custom properties as design tokens.**

A strict division of responsibility:

| Tool                                     | Responsibility                                                       | Forbidden for                         |
| ---------------------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| **CSS custom properties** (`tokens.css`) | Color, radius, duration, easing, typography, spacing, shadow         | —                                     |
| **Tailwind utilities**                   | Layout (flex/grid/gap), spacing, simple variants, responsive         | Hardcoded visual values               |
| **Semantic CSS** (separate files)        | Complex components: shell, overlay, multi-step animation, log viewer | Anything Tailwind can already express |

## Consequences

**Positive**

- Tokens are the **single source of truth**; the theme changes by changing token values.
- Still productive for layout (Tailwind's strength) without sacrificing consistency.
- Complex components stay readable because they are not forced into utility soup.
- A clear boundary: visual values **always** come from tokens, never from literals.

**Negative / risks**

- Requires discipline: it is easy to fall back to `bg-[#fff]`. Mitigated by a custom ESLint rule (R3.1–R3.4).
- Two styling languages remain — but with **a written and enforced boundary**,
  which is the core of the problem described above.

## Enforcement

- A custom ESLint rule rejects color/radius/duration literals and `style={{}}` (R3.1–R3.4).
- Review rejects utilities that state visual values that should be tokens.

## Rejected alternatives

| Alternative                           | Reason for rejection                                                   |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Pure CSS Modules                      | Cleanest, but slow to prototype and the file count explodes            |
| Pure utility-first Tailwind           | Complex components become class soup — exactly what was rejected above |
| CSS-in-JS (styled-components/emotion) | Runtime cost, no single token source, shrinking ecosystem              |
