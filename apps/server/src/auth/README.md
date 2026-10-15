# `auth`

Who may open the console (D8, ADR-0008): one password, one session cookie, no accounts.

## What it owns

The single operator's credential and the sessions it opens. It decides what makes a
password acceptable, when a session expires, when it slides, and which sessions a
password change ends. The cookie's shape — HttpOnly, SameSite, when `Secure` is set —
lives here too. Authentication _enforcement_ (refusing a request) is
`ingress`'s `sessionGuard`, which reads this service; this folder never sees a route.

## The files that matter

- **`service.ts`** — `AuthService` (`status`, `resolve`, `setup`, `login`, `logout`,
  `changePassword`). `liveSession` is the whole expiry story: drop an expired row,
  slide one that is past the halfway mark, else return it.
- **`guard.ts`** — `sessionGuard`. An **allowlist** (`OPEN_PATHS`) of the four routes
  reachable before a session exists: status, setup, login, logout.
- **`cookie.ts`** — read/write/clear `rutekit_session`.

## Invariants and traps

- **The cookie value is never stored.** Only its SHA-256 (`hashToken`) is in
  `sessions`; the token is 256 random bits minted per session.
- **The guard is an allowlist, not a denylist.** A route added in a later phase is
  closed until someone deliberately opens it — forgetting fails to a 401 in dev, not
  an open endpoint in production. Keep it that way.
- **SameSite=Lax is the entire CSRF story.** Every mutating console route is a POST,
  PATCH or DELETE, and Lax withholds the cookie from all three cross-site. Do not add
  a mutating GET.
- **`Secure` is set only when `x-forwarded-proto` is `https`.** The server speaks
  plain HTTP behind a proxy; a `Secure` cookie handed back over http is silently
  dropped by the browser, so the proxy's header is the only honest signal.
- **Expiry slides only past the halfway mark.** Renewing every request would be a
  write per request; never renewing would log out an active operator.
- **A password change deletes every other session, keeping the caller's own.** The
  caller has just proved it knows both passwords.
- `status` answers 200 in all three states — "not signed in" is an answer, not an
  error — which is why the login gate can poll it before it knows anything.
- The clock is injected (`deps.now`) so every expiry branch is testable without
  waiting.
