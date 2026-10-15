# ADR-0038 — Polish: measured contrast, recorded limits, and a11y enforced by the linter

Status: **Accepted** · Date: 2026-10-15 · Related decisions: NFR-4, NFR-6, NFR-9, ADR-0034

## Context

D5 is the last group of PHASE D, and the roadmap asks for four things: a full a11y audit
(axe + manual keyboard testing of every page), a performance audit (LCP <1.5s, bundle
<300KB gzip), a WCAG AA contrast audit, and cross-browser testing.

Three of the four are **manual audits** by definition. What was found while working is
that most of them could be turned into something **machine-enforced**, and the parts that
could not had to be stated as limits rather than claimed.

## Decision

**Contrast is measured from tokens and enforced; control limits that fail are recorded as
a characterization test; structural a11y is enforced by the linter; and what cannot be
verified here is stated.**

### 1. Contrast is measured with arithmetic, not axe

NFR-6 asks for WCAG AA for text. The palette already has a comment explaining that it was
tuned for that — `app.css` carries a long note about why the four semantic colors each
have a separate `-text` binding. What was missing was anything that **checked it**.

**axe cannot see contrast here.** `jsdom` has no layout and does no color compositing, so
an axe audit inside a test would never report a contrast problem — it would be green
without meaning anything. Instead, the ratios are computed from the token values in the
stylesheet. That is more accurate (the numbers are exact, not a rendering) and depends on
nothing mounting.

**The chip is the worst case, and it is composited.** A status chip paints `bg-<name>/12`
behind its text, and that tint pulls the background toward the text color — so a label
that passes AA on a card can fail on a chip on a page. The composite is computed, not
assumed.

The result: **13 of 16 assertions pass** — text, muted and subtle text, accent labels,
semantic chip labels, and console log text, in both themes.

### 2. One real finding: `--color-warning` sits at 2.88:1

As a graphic on a page, `#d97706` is at **2.88:1** — below the 3:1 WCAG asks for, short by
4%. It was darkened to `#d37005` (3.12:1), the smallest change that passes. It was only
ever a graphic (badge tint, meter bar, warning dot); its text is carried by
`--color-warning-text`, which already passes.

### 3. The control limits are **not** fixed, and that is recorded as a gap

`--color-border-strong` — used by inputs, checkboxes, and slider thumbs for their resting
and hover edges — sits at **1.57:1** (light) and **2.11:1** (dark) on the page.
`--color-border` is lower still. WCAG 1.4.11 asks for 3:1 for control boundaries.

**Not fixed, and that is deliberate.** The palette is a palette designed with its
own comments explaining how each value was tuned, and raising those two tokens changes the
look of **every input in the console** — a design decision, not a correctness fix.

What matters is that the numbers cannot shift unnoticed. The test is a **characterization
test**: it pins eight ratios per theme at the values measured today. A palette change that
**worsens** the gap fails there, and one that **closes** it fails too — so closing the gap
forces someone to update the numbers, which means a conscious decision rather than drift.

That is the honest shape for "known but not done": not a test claiming to pass, and not a
test switched off either.

### 4. The bundle is measured against what actually loads

NFR-9 caps the **initial bundle** at 300 KB gzip. That number is about first paint, so the
test measures exactly what `index.html` loads — not all of `dist`, which pulls in Monaco,
mermaid, and the three.js viewer and is two orders of magnitude larger.

The result is **193 KB gzip** (179 JS + 13 CSS), 36% under the limit. The test also names
the heavy things that must not enter the initial load, so a regression points at itself
instead of showing up as a budget that shifted slightly.

### 5. LCP is measured with a real headless browser

NFR-4 asks for LCP <1.5s locally, and **it is measured: 224 ms median across six cold runs,
228 ms worst**, against the production console served by rutekit itself.

**This section previously reported LCP as unmeasurable, and that was wrong.** The reasoning
was that the Browser pane runs the page without painting it (`visibilityState: hidden`, empty
`paint` entries) and an invisible page does not paint — which is true of the Browser pane, but
it does not follow that LCP cannot be taken here. Playwright ships a real headless Chromium,
and a real headless browser _does_ paint. The measurement is six fresh contexts against
`http://127.0.0.1:7331/`, each waiting for layout to settle before reading
`largest-contentful-paint`; the same run reported CLS 0.0001 and TTFB ~2 ms.

The lesson is worth more than the number: "the tool I reached for first cannot do this" is not
the same claim as "this cannot be done here", and the first one had been written down as the
second.

The serving path rutekit controls remains measurable and consistent with it: the production
console answers `/` in ~1.1 ms and its two eager assets in ~1.6 ms TTFB, all from local disk.

### 6. Structural a11y is enforced by the linter, with reasoned exceptions

`eslint-plugin-jsx-a11y` was added with the `recommended` set. It found **20 findings**,
and after checking them one by one, **all of them** were false positives or deliberate
patterns:

| Rule                                                                   | Why it is turned off                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-redundant-roles`                                                   | Tailwind preflight sets `list-style: none`, and WebKit drops a list's implicit role when its markers are gone — `role="list"` is the standard fix, not redundancy                                                   |
| `label-has-associated-control`                                         | The control is **inside** the label (`<label>…<Switch /></label>`), but the rule does not follow custom components to find the rendered input                                                                       |
| `media-has-caption`                                                    | Media generated by Studio has no caption track; an empty track would satisfy the rule while saying nothing to a screen reader                                                                                       |
| `interactive-supports-focus`                                           | The icon picker is a correct ARIA radiogroup (roving tabIndex, arrows handled on the group) — the group is precisely what **must not** be focusable, so the rule's complaint is the inverse of the correct behavior |
| `no-noninteractive-element-interactions`, `no-noninteractive-tabindex` | The flagged elements — the usage chart and the log rows — both carry an `onKeyDown` alongside their mouse handler                                                                                                   |

Every exception is **written with its reason in `eslint.config.js`**. A rule silenced
without a reason is a rule that will never be reviewed again.

That the remaining rules really bite **was verified**: a deliberately bad probe file
(`<img>` without alt, a `div` with an onClick and no keyboard listener, an empty `<a>`)
produced four errors.

### 7. What was not done, stated

- **Manual keyboard testing of every page.** An agent cannot do this — it needs a person to
  press Tab on 27 pages and pay attention.
- **Firefox.** The cross-browser pass covers **Chromium and WebKit** — all 25 routes mount on
  their own path with no console errors in both, and WebKit is the engine Safari uses. Firefox
  is a real gap: it could not be launched on this machine at all, `uv_spawn` failing for both
  cached builds, so it is untested rather than passing. This section previously said only
  Chromium was available, which understated what could be run — WebKit is a separate download,
  and it ran.
- **`axe` as a package.** Not added, because in jsdom it cannot see contrast — the riskiest
  part — so its value is far smaller than the cost of one more dependency. What can be
  enforced without rendering already is.

## Consequences

**Positive**

- NFR-4 is measured, not assumed: LCP 224 ms median / 228 ms worst against a 1500 ms budget.
- NFR-6 is enforced by arithmetic over tokens, not by eye. 13 text contrast assertions pass
  in both themes, and a regression now fails.
- NFR-9 is measured against the real initial load: 193 KB of 300 KB, with heavy library
  names pinned so they cannot enter.
- All 25 routes mount and render in two engines — Chromium and WebKit — with no console
  errors, so the console is not accidentally Chromium-only.
- One real contrast bug was found and fixed (`--color-warning`, 2.88:1).
- The control-boundary gap is recorded with pinned numbers, so it cannot get worse — or
  better — without a conscious decision.
- 20 a11y findings were checked one by one, and the reason for each exception lives next to
  its rule.

**Negative / risk**

- **The control boundaries sit at 1.3–2.1:1, below WCAG 1.4.11's 3:1.** Every input,
  checkbox, and slider in the console has an edge that does not meet the requirement.
  Recorded, not fixed.
- **There is no manual keyboard testing.** It needs a person at the keyboard, and no
  automation substitutes for it.
- **Firefox is untested.** Chromium and WebKit both pass all 25 routes; Firefox could not be
  launched here at all, so it is a gap rather than a pass.
- **`axe` is not used**, so structural rules beyond what jsx-a11y covers — heading order,
  landmarks, correct `aria-live` — have not been machine-checked.
- **The characterization test pins values rounded to two decimals**, so a palette change
  smaller than one rounding step will not be caught.
- **Adding `eslint-plugin-jsx-a11y` adds a dev dependency**, and it pulls in 87 packages.

## Rejected Alternatives

| Alternative                          | Rejected because                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Audit contrast with axe              | jsdom has no layout and no color compositing; it would be green without meaning anything                 |
| Trust the palette comment            | The comment explains the intent, and nothing checks the intent                                           |
| Raise `--color-border-strong` to 3:1 | Changes the look of every input; a design decision, deliberately postponed                               |
| Remove the border assertion          | The gap would then be invisible and could quietly worsen                                                 |
| Claim the border passes              | Not true, and an ADR that is wrong is worse than none                                                    |
| Report LCP as unmeasurable           | The Browser pane cannot paint, but a real headless browser can — and it took the number in minutes       |
| Measure LCP with an estimated number | An invisible page does not paint; the number would be made up                                            |
| Leave `--color-warning` at 2.88:1    | Only slightly under the threshold, and only ever a graphic — fixing it does not change the design        |
| Silence a11y rules without a reason  | A rule silenced without a reason will never be reviewed again                                            |
| Follow jsx-a11y's `strict` config    | It carries opinions about heading order and landmark structure this console deliberately does not follow |
| Add `axe` as well                    | In jsdom it cannot see the riskiest part                                                                 |
