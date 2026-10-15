/**
 * The client labels the denylist picker offers.
 *
 * A client-router denylist entry is matched against the label a client sends, so
 * the value is not a model id or a URL — it is whatever name that piece of
 * software calls itself. Nobody remembers those exactly, and a denylist that
 * fails to match because it says `roo_code` instead of `roo-code` fails silently,
 * which is the worst way for an access rule to fail.
 *
 * So this is a vocabulary of the labels an operator is most likely to want, in
 * two groups: coding agents and editors that reach an endpoint on a person's
 * behalf, and the third-party routers and gateways that resell one. Both are
 * things a self-hosted router is commonly asked to refuse, and neither is a
 * closed set — the field still takes anything typed, and says when a value is
 * one it does not recognise.
 *
 * Nothing here renders, so it is importable from the form without breaking fast
 * refresh.
 */

/** Labels for coding agents and editors that call an endpoint as a client. */
const CODING_CLIENTS: readonly string[] = [
  'aider',
  'amp',
  'augment',
  'claude-code',
  'cline',
  'codeium',
  'cody',
  'continue',
  'copilot',
  'crush',
  'cursor',
  'gemini-cli',
  'goose',
  'kilocode',
  'kiro',
  'opencode',
  'qodo',
  'qwen-code',
  'roo-code',
  'sweep',
  'tabnine',
  'trae',
  'void',
  'windsurf',
  'zed',
];

/** Labels for routers and gateways that resell an endpoint rather than use it. */
const ROUTERS: readonly string[] = [
  'bifrost',
  'higress',
  'langdb',
  'litellm',
  'new-api',
  'one-api',
  'openrouter',
  'portkey',
  'requesty',
  'unify',
];

/**
 * The picker's list, sorted so the dropdown reads like a list rather than like
 * two lists glued together. The grouping above is what keeps the set curated;
 * the operator only ever sees one alphabet.
 */
export const CLIENT_LABELS: readonly string[] = [...CODING_CLIENTS, ...ROUTERS].sort((a, b) =>
  a.localeCompare(b),
);
