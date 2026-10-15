import { z } from 'zod';

/**
 * Pointing a coding client at this instance (FR-2.4, C13c).
 *
 * rutekit speaks two client-facing dialects — OpenAI-compatible at
 * `/v1/chat/completions` and Anthropic-compatible at `/v1/messages` — so almost
 * every coding agent or editor can be aimed at it by setting three values: a base
 * URL, a key, and a model. What differs is *where* those three go: an environment
 * variable, a TOML file, a VS Code setting, a YAML block.
 *
 * **The catalogue is data, and it lives here rather than in the page.** The same
 * reason the provider manifests do (ADR-0018): a statement about how some other
 * piece of software is configured is not a rendering concern, and putting it in
 * `apps/web` would make it unreachable from anywhere else — including the CLI
 * that C13c's sibling work will eventually ship. Nothing here reads a file or
 * touches the network; it is a table and a pure function.
 *
 * **Nothing is written to anyone's disk.** Every reference project this one
 * learned from (`/dashboard/cli-tools`, `src/lib/client-configs/`) runs its
 * console on the operator's own machine, so it detects which clients are
 * installed and edits their config files. rutekit's console is a web page against
 * a server that may be on another host entirely: it cannot detect anything, and
 * it must not be able to write into a home directory it has no business knowing
 * about. So the output is text, and the operator pastes it. That is a smaller
 * feature than a file-writer and a strictly better one.
 *
 * **`formatVerified` is an admission, not a quality signal.** It is `true` only
 * where the snippet's shape was checked against the client's own documentation in
 * this repository's development environment, and `false` where it was written
 * from knowledge of the client and has not been run. Shipping an unverified
 * snippet is a real risk — a wrong key name fails silently and looks like rutekit
 * being broken — so the flag exists to be shown to the operator rather than to be
 * quietly true.
 */

/** Which of rutekit's two client-facing dialects a tool should be pointed at. */
export const cliToolSurfaceSchema = z.enum(['openai', 'anthropic']);

/**
 * How a client wants the base URL spelled.
 *
 * This is the single most common way a config that looks right does not work.
 * Some clients take the server root and append the path themselves; others want
 * the `/v1` included. Which one a client is cannot be inferred from anything, so
 * it is declared per tool rather than guessed at render time.
 */
export const cliBaseUrlSuffixSchema = z.enum(['none', 'v1']);

export const cliToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** One line: what this client is, and who would use it. */
  description: z.string(),
  surface: cliToolSurfaceSchema,
  /** Appended to the operator's base URL to get what this client expects. */
  baseUrlSuffix: cliBaseUrlSuffixSchema,
  /**
   * Where this client's config lives, as a hint to the operator.
   *
   * Named `configLocation` rather than `configPath` because not every client
   * keeps one: an editor's is a settings pane rather than a file an operator can
   * open by path, and the two generic entries have no config of their own at all
   * (`null`).
   */
  configLocation: z.string().nullable(),
  /**
   * The client's documentation, at the root of its docs rather than a deep link.
   *
   * Deliberately shallow: a deep link into a docs tree is the kind of URL that
   * rots silently, and this one exists so an operator can check a snippet they do
   * not trust. A root that still works is worth more than a precise path that may
   * not.
   */
  docsUrl: z.string().nullable(),
  /** Whether this snippet's shape was checked against the client's docs. See the file header. */
  formatVerified: z.boolean(),
});

export const cliSnippetSchema = z.object({
  id: z.string(),
  /** What the block is: `Shell`, `config.toml`, `VS Code settings`. */
  label: z.string(),
  language: z.enum(['bash', 'json', 'toml', 'yaml']),
  /** The file to put it in, or `null` when it is not a file. */
  filename: z.string().nullable(),
  body: z.string(),
});

export type CliToolSurface = z.infer<typeof cliToolSurfaceSchema>;
export type CliBaseUrlSuffix = z.infer<typeof cliBaseUrlSuffixSchema>;
export type CliTool = z.infer<typeof cliToolSchema>;
export type CliSnippet = z.infer<typeof cliSnippetSchema>;

/** The three values every snippet is built from. */
export interface CliTarget {
  /** The origin a client should reach rutekit on. Trailing slashes are trimmed. */
  readonly baseUrl: string;
  /** An API key's secret. Empty is allowed — the snippet is still worth reading. */
  readonly apiKey: string;
  readonly model: string;
}

/**
 * The clients this page writes config for.
 *
 * A deliberately short list. Every entry here is a snippet rutekit is willing to
 * put in front of an operator, and the honest cost of a longer list is a longer
 * list of formats nobody checked — so the two generic entries carry the weight
 * instead, and the description of each names the clients it also covers.
 */
export const CLI_TOOLS: readonly CliTool[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic’s own CLI, and the client this instance is most often put behind.',
    surface: 'anthropic',
    // Verified against the SDK this CLI is built on: it composes its request as
    // `baseURL + '/v1/messages'`, so the base URL must be the origin alone. A
    // `/v1` here sends every request to `/v1/v1/messages`, which is the most
    // common way this configuration looks right and does not work.
    baseUrlSuffix: 'none',
    configLocation: '~/.claude/settings.json',
    docsUrl: null,
    formatVerified: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI’s CLI agent. Reads a TOML file with a named model provider.',
    surface: 'openai',
    baseUrlSuffix: 'v1',
    configLocation: '~/.codex/config.toml',
    docsUrl: 'https://github.com/openai/codex',
    formatVerified: false,
  },
  {
    id: 'cline',
    name: 'Cline',
    description: 'The VS Code agent. Configured through editor settings.',
    surface: 'openai',
    baseUrlSuffix: 'v1',
    configLocation: 'VS Code settings.json',
    docsUrl: 'https://docs.cline.bot',
    formatVerified: false,
  },
  {
    id: 'continue',
    name: 'Continue',
    description: 'The Continue extension’s assistant and autocomplete models.',
    surface: 'openai',
    baseUrlSuffix: 'v1',
    configLocation: '~/.continue/config.yaml',
    docsUrl: 'https://docs.continue.dev',
    formatVerified: false,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'The terminal agent. Declares a provider through its own config file.',
    surface: 'openai',
    baseUrlSuffix: 'v1',
    configLocation: '~/.config/opencode/opencode.json',
    docsUrl: 'https://opencode.ai/docs',
    formatVerified: false,
  },
  {
    id: 'openai-compatible',
    name: 'Any OpenAI-compatible client',
    description:
      'Kilo, Roo Code, Aider, Zed, Windsurf and the rest take the same three values in their own shape.',
    surface: 'openai',
    baseUrlSuffix: 'v1',
    configLocation: null,
    docsUrl: null,
    formatVerified: true,
  },
  {
    id: 'anthropic-compatible',
    name: 'Any Anthropic-compatible client',
    description:
      'For a client with an Anthropic mode: the Messages API rather than chat completions.',
    surface: 'anthropic',
    baseUrlSuffix: 'none',
    configLocation: null,
    docsUrl: null,
    formatVerified: true,
  },
];

export function cliToolById(id: string): CliTool | null {
  return CLI_TOOLS.find((tool) => tool.id === id) ?? null;
}

/** The base URL as this tool wants it spelled. */
export function baseUrlFor(tool: CliTool, target: CliTarget): string {
  const root = target.baseUrl.trim().replace(/\/+$/, '');
  return tool.baseUrlSuffix === 'v1' ? `${root}/v1` : root;
}

/**
 * The blocks to show for one tool.
 *
 * A pure function of the catalogue entry and the three values, so the page holds
 * no config knowledge and a test can assert every entry produces something
 * usable. It returns a list rather than a string because a client may need the
 * same values in two places — a file and an environment variable that names it.
 *
 * The generic entries are the ones worth reading even when the operator's client
 * is not in the list: they are rutekit's own surfaces described in the two
 * dialects, and everything else is a spelling of one of them.
 */
export function snippetsFor(tool: CliTool, target: CliTarget): readonly CliSnippet[] {
  const base = baseUrlFor(tool, target);
  const { apiKey, model } = target;

  switch (tool.id) {
    case 'claude-code':
      return [
        {
          id: 'shell',
          label: 'Shell',
          language: 'bash',
          filename: null,
          body: [
            `export ANTHROPIC_BASE_URL=${base}`,
            `export ANTHROPIC_AUTH_TOKEN=${apiKey}`,
            `export ANTHROPIC_MODEL=${model}`,
            // Verified gotcha: with a token *and* a key exported the CLI sends
            // both headers, and which one a gateway honours is then the
            // gateway's decision. Clearing the key makes the token the only one.
            'unset ANTHROPIC_API_KEY',
          ].join('\n'),
        },
        {
          id: 'settings',
          label: 'settings.json',
          language: 'json',
          filename: '~/.claude/settings.json',
          body: [
            '{',
            '  "env": {',
            `    "ANTHROPIC_BASE_URL": "${base}",`,
            `    "ANTHROPIC_AUTH_TOKEN": "${apiKey}",`,
            `    "ANTHROPIC_MODEL": "${model}"`,
            '  }',
            '}',
          ].join('\n'),
        },
      ];

    case 'codex':
      return [
        {
          id: 'config',
          label: 'config.toml',
          language: 'toml',
          filename: '~/.codex/config.toml',
          body: [
            `model = "${model}"`,
            'model_provider = "rutekit"',
            '',
            '[model_providers.rutekit]',
            'name = "rutekit"',
            `base_url = "${base}"`,
            `env_key = "RUTEKIT_API_KEY"`,
          ].join('\n'),
        },
        {
          id: 'env',
          label: 'Shell',
          language: 'bash',
          filename: null,
          body: [`export RUTEKIT_API_KEY=${apiKey}`].join('\n'),
        },
      ];

    case 'cline':
      return [
        {
          id: 'settings',
          label: 'VS Code settings.json',
          language: 'json',
          filename: 'VS Code settings.json',
          body: [
            '{',
            '  "cline.apiProvider": "openai",',
            `  "cline.openAiBaseUrl": "${base}",`,
            `  "cline.openAiApiKey": "${apiKey}",`,
            `  "cline.openAiModelId": "${model}"`,
            '}',
          ].join('\n'),
        },
      ];

    case 'continue':
      return [
        {
          id: 'config',
          label: 'config.yaml',
          language: 'yaml',
          filename: '~/.continue/config.yaml',
          body: [
            'models:',
            '  - name: rutekit',
            '    provider: openai',
            `    model: ${model}`,
            `    apiBase: ${base}`,
            `    apiKey: ${apiKey}`,
          ].join('\n'),
        },
      ];

    case 'opencode':
      return [
        {
          id: 'config',
          label: 'opencode.json',
          language: 'json',
          filename: '~/.config/opencode/opencode.json',
          body: [
            '{',
            '  "provider": {',
            '    "rutekit": {',
            '      "npm": "@ai-sdk/openai-compatible",',
            '      "options": {',
            `        "baseURL": "${base}",`,
            `        "apiKey": "${apiKey}"`,
            '      },',
            '      "models": {',
            `        "${model}": {}`,
            '      }',
            '    }',
            '  }',
            '}',
          ].join('\n'),
        },
      ];

    case 'openai-compatible':
      return [
        {
          id: 'env',
          label: 'Shell',
          language: 'bash',
          filename: null,
          body: [
            `export OPENAI_BASE_URL=${base}`,
            `export OPENAI_API_KEY=${apiKey}`,
            `export OPENAI_MODEL=${model}`,
          ].join('\n'),
        },
        {
          id: 'json',
          label: 'JSON',
          language: 'json',
          filename: null,
          body: [
            '{',
            `  "base_url": "${base}",`,
            `  "api_key": "${apiKey}",`,
            `  "model": "${model}"`,
            '}',
          ].join('\n'),
        },
      ];

    case 'anthropic-compatible':
      return [
        {
          id: 'env',
          label: 'Shell',
          language: 'bash',
          filename: null,
          body: [
            `export ANTHROPIC_BASE_URL=${base}`,
            `export ANTHROPIC_AUTH_TOKEN=${apiKey}`,
            `export ANTHROPIC_MODEL=${model}`,
          ].join('\n'),
        },
        {
          id: 'json',
          label: 'JSON',
          language: 'json',
          filename: null,
          body: [
            '{',
            `  "base_url": "${base}",`,
            `  "auth_token": "${apiKey}",`,
            `  "model": "${model}"`,
            '}',
          ].join('\n'),
        },
      ];

    default:
      // A catalogue entry with no snippet is a bug in this file, not a case the
      // page should have to render. Returning nothing is what keeps the failure
      // visible: the page shows an empty card rather than a plausible snippet for
      // a client nobody wrote one for.
      return [];
  }
}

/**
 * The two surfaces, as a sentence, for the page's own explanation.
 *
 * rutekit does not translate a client's *own* protocol — it accepts the two
 * dialects clients already speak. Saying which one a tool uses is the difference
 * between "point it at rutekit" and "point it at rutekit, in the right mode".
 */
export const CLI_SURFACE_LABELS: Readonly<Record<CliToolSurface, string>> = {
  openai: 'Chat completions',
  anthropic: 'Messages',
};

/** The request path each surface is reached at, for the page's note. */
export const CLI_SURFACE_PATHS: Readonly<Record<CliToolSurface, string>> = {
  openai: '/v1/chat/completions',
  anthropic: '/v1/messages',
};
