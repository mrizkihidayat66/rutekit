/**
 * The CLI Tools page's own vocabulary.
 *
 * Nothing here knows how any client is configured — that is `@contracts`'
 * `cli-tools.ts`, and it is there so the same catalogue can serve the CLI later.
 * This file is only the page's defaults and the one thing the page has to decide
 * for itself: what to pre-fill the base URL with.
 */

/**
 * The base URL the field starts at.
 *
 * **The browser's own origin, not the server's bind address.** They are usually
 * the same, but they are the same for different reasons and only one of them is
 * the right answer here.
 *
 * The server knows `RUTEKIT_HOST` and `RUTEKIT_PORT` — `127.0.0.1:7331` by
 * default — and that is exactly the value that does *not* work for the client
 * this page exists to configure. A coding agent on a laptop pointed at
 * `127.0.0.1` means "the laptop", so an operator reaching rutekit over the LAN
 * would get a client that talks to nothing, with no error that says why.
 *
 * The origin the browser is on is the address that demonstrably works from
 * wherever the operator is standing: the page they are reading this on loaded
 * from it. It is still only a default — behind a reverse proxy it may be the
 * console's origin rather than the API's — which is why the field is editable
 * and why the card says so instead of presenting the value as fact.
 */
export function defaultBaseUrl(): string {
  return window.location.origin;
}

/** What the field is, said once, in the place it matters. */
export const BASE_URL_DESCRIPTION =
  'Where a client should reach rutekit. Filled in with the address this console is on, which is right unless the API is served from somewhere else.';

/** Why the key field is a paste box and not a list of the keys that exist. */
export const API_KEY_DESCRIPTION =
  'A key’s secret is shown once, when it is created, and only its hash is stored — so this is a paste field rather than a picker. Create one on the API Keys page and paste it here.';

/** Why the model field is free text with suggestions. */
export const MODEL_DESCRIPTION =
  'The model a client should ask for. Anything rutekit can route works, including an alias you have defined.';
