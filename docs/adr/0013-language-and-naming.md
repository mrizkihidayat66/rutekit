# ADR-0013 — Language: English only (v1), no design-system codename

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D13, D14

## Context

Comparable routers in this space ship multi-language i18n (5 languages: en/es/ja/vi/zh-CN)
plus a documentation site per language. Setting up full i18n means every string
must go through `t()`, every copywriting change touches N translation files, and
every UI test must be run in N locales.

Separately from that, a naming question arises: whether the design system is given a
codename (e.g. "Rute" or "Jalur") with a token prefix, or uses a generic prefix.

## Decision

### D13 — Language

**English only for v1.** The i18n framework (`react-i18next`) is **set up from the
start** so strings do not need to be patched later, but only the `en` locale is filled in.
Other languages follow from community contributions in v2+.

### D14 — Design system

**No codename.** Tokens use a generic prefix directly:
`--color-*`, `--radius-*`, `--dur-*`, `--font-*`, `--shadow-*`.
Components live in `apps/web/src/components/ui/`, not `@rutekit/<codename>`.

## Consequences

**Positive**

- v1 scope shrinks significantly (no multiplied copywriting, no i18n tests).
- Focus on features and quality, not language coverage.
- Generic tokens are easy to read and need no name-mapping documentation.
- Component names are directly descriptive (`Card`, `Button`) with no branding layer.

**Negative / risks**

- Non-English adoption is hindered in v1.
- Adding a locale later to strings that were hardcoded after all will require a sweep.

## Mitigation

- `react-i18next` is installed from Phase A, and **every UI string must go through `t()`**
  from the start — even when there is only one locale. This prevents a large sweep later.
- The single locale file `locales/en.json` becomes a template translators can copy.
- Generic tokens also make it easier for anyone to read the code without a name dictionary.

## Rejected alternatives

| Alternative                               | Reason for rejection                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| English + Indonesian from the start       | Doubles copywriting and testing effort; not worth it for v1                |
| Indonesian only                           | Limits global adoption and community contributions                         |
| Fully hardcoded strings (no i18n)         | An unnecessary large sweep when adding a language                          |
| A design-system codename ("Rute"/"Jalur") | Adds a naming layer with no real benefit; generic tokens are more readable |
