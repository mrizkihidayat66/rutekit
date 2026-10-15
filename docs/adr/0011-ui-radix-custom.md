# ADR-0011 — UI components: Radix primitives + custom styling

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D11, D7

## Context

The design system must be of a high caliber, with components written by hand rather
than adopted wholesale. Three options:
Radix + own styling, shadcn/ui (ready-made components on top of Radix), or
fully custom.

## Decision

**Radix Primitives** for behavior and accessibility + **own styling** with
Tailwind + CSS tokens (ADR-0007).

Primitives used: `dialog`, `select`, `dropdown-menu`, `tabs`, `tooltip`,
`switch`, `popover`, `scroll-area`, `checkbox`, `slider`, `accordion`.
Icons: `lucide-react`.

## Consequences

**Positive**

- Accessibility that is hard to build yourself (focus trap, ARIA combobox, menu
  keyboard navigation) comes for free and battle-tested.
- 100% visual control — no default styles to fight in order to reach that
  caliber of craft.
- Every component in `components/ui/` is a thin wrapper → easy to audit and change.
- R4.1–R4.9 (a11y requirements) become far easier to satisfy.

**Negative / risks**

- More styling code written by hand than with shadcn/ui.
- Requires understanding the Radix API for each primitive.

## Mitigation

Every Radix primitive is wrapped **once** in `components/ui/` with an API
consistent with the design system. Pages never touch Radix directly.

## Rejected alternatives

| Alternative           | Reason for rejection                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shadcn/ui             | Fast, but its default styling makes the app look generic — it needs heavy re-theming to reach that caliber of craft; it also adds unnecessary dependencies |
| Fully custom          | Large effort (every component written from scratch), and a high risk of a11y bugs in focus traps and comboboxes                                            |
| Headless UI / Ariakit | Viable, but Radix has the broadest primitive coverage and the widest adoption                                                                              |
