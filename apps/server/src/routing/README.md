# `routing`

The three records that decide what a model name means: aliases, combos, and model
mappings (FR-1.3–1.5).

## What it owns

The console's CRUD over those three records, and the one shared paging/sorting helper. The
_resolution_ of them — the order they are consulted in — is `plan/`'s; this folder only
stores and edits them, and reuses the planner's engine where a preview must agree with a
turn.

## The files that matter

- **`aliases.ts`** — `AliasService`. **`combos.ts`** — `ComboService`. **`mappings.ts`** —
  `MappingService`, including `preview` (which imports `plan/mapping.ts`'s `applyRule`).
- **`list.ts`** — `offsetOf`, `sortRows`, `paginate`: the one paging protocol and tie-break
  the three services share.

## Invariants and traps

- **A name is fixed once it exists.** Both an alias's `alias` and a combo's `name` are
  refused on change — the name is the _interface_ (a client sends it), so renaming is
  retiring one name and introducing another. The console disables the field; the service
  refuses it for anyone driving the API by hand.
- **Combo `entries` are replaced wholesale, never merged.** The list's order is its
  meaning, so a merge would have to renumber anyway. An **absent** `entries` means "leave
  the chain alone" (the update schema drops defaults), not "empty it".
- **`preview` uses the planner's own `applyRule`**, so a preview cannot agree with a panel
  and disagree with a turn. A bad pattern the planner would skip is reported as a
  non-match, not as an error.
- **`sortRows` leaves the order alone for an absent _or_ unrecognised `sort`.** Each
  repository's `list` already returns a defensible order (a mapping list comes back in
  pipeline order), and an unknown key from a stale page must not 400.
- **Ties break on the row id**, so a row cannot be shown twice or skipped across pages.
- **A numeric key compares numerically** — a mapping's `priority` sorted as text would put
  10 before 2.
- **Unreadable stored columns degrade rather than throw**: `toCombo` reads `strategy`
  through the same fail-open parser the planner uses, and `toMapping` falls back to `exact`
  for an unrecognised `match`.
- Filter Rules and the Token Saver also live under the Routing nav section but are **not**
  here — they are `tools.ts` and `token-saver.ts` respectively.
