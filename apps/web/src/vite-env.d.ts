/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Injected at build time by the release pipeline; absent in local dev. */
  readonly VITE_RUTEKIT_VERSION?: string;
  /**
   * `on` starts the mock layer instead of talking to the server.
   *
   * Anything else — including leaving it unset — sends every request to the
   * network, which in dev is the Vite proxy and therefore the real server. See
   * `src/mocks/mock-mode.ts` for why the real server is the default.
   */
  readonly VITE_MOCKS?: string;
}
