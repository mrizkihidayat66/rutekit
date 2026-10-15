# ADR-0014 — Chat page: tiered Provider → Model selection

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D15

## Context

`rutekit` has 30+ providers, each with many models. The Chat page must let users pick a
model to talk to. Three patterns were found in research:

| Pattern              | Example                            | Pros                        | Cons                                                              |
| -------------------- | ---------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| **Flat picker**      | ChatGPT-Next-Web (`CUSTOM_MODELS`) | Simple                      | Overwhelming with 100+ models; the provider label becomes a badge |
| **Provider-grouped** | LibreChat                          | Organized; natural grouping | Two levels, more clicks                                           |
| **Auto-route**       | —                                  | Most seamless               | The user loses control over which provider is used                |

`rutekit` is fundamentally a **cross-provider router** — a user of this page very likely
cares which provider the request goes through (cost, quota, which account is used).

## Decision

**Tiered selection: Provider first → then a model from that provider.**

```
Header: [Provider ▾] → [Model ▾] → [Thinking ▾]
```

- **Provider** is the first choice. The dropdown shows only providers that have an
  `active` account (providers without a healthy account are marked disabled with a reason).
- **Model** shows the models of the selected provider, with models that have remaining
  quota at the top.
- **Thinking** shows the level (`auto`/`low`/`medium`/`high`/`xhigh`/`max`) only if the
  selected model supports it.

The selection is stored per session; creating a new session inherits the last selection.

## Consequences

**Positive**

- The user is explicitly aware of which provider serves the request — important for a
  router that has per-account quota/cost.
- Prevents "why is the cost different" surprises when the system silently picks a provider.
- Scales to 30+ providers without a scary dropdown.
- Aligned with the architecture: the provider is the unit that owns accounts, quota, and health.

**Negative / risks**

- Two interactions to reach a model (one click more than a flat picker).
- The same model available on several providers requires picking a provider first
  before that model can be seen.

## Mitigation

- The model dropdown supports direct search; typing a model name shows cross-provider
  results as a shortcut, then the provider is selected automatically.
- The most recently used provider is placed at the top.
- An "Auto" shortcut is provided that lets the system pick the provider (round-robin
  with a least-inflight bias), for users who genuinely do not care — but this
  is an explicit option, not a silent default.

## Rejected alternatives

| Alternative                                         | Reason for rejection                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A flat picker of all models                         | Unmanageable at the scale of 30+ providers; loses provider awareness                                                                                                                            |
| A provider-grouped dropdown (the LibreChat pattern) | Good, but still one level — the user does not know which provider is selected until opening the menu; the two-dropdown approach makes the provider choice explicit and persistent in the header |
| Auto-route as the default                           | Hides the provider from the user in a tool that is precisely about providers                                                                                                                    |
