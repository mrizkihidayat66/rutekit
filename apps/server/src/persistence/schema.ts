import type {
  BenchmarkAssertion,
  BenchmarkTarget,
  BenchmarkVariant,
  ChatAttachment,
  ChatMessageMeta,
  ContentBlock,
  FamilyPosterior,
  ProbeSignal,
} from '@contracts';
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The database schema, in Drizzle (ADR-0004).
 *
 * The schema is staged: a domain table lands with the phase that owns its shape,
 * once its contract in `packages/contracts` is settled. `provider_accounts` is
 * the first of them — it arrived with the OAuth flow, because a flow that
 * exchanges a token has to have somewhere to put it. A migration is immutable
 * once released (R5.8), so a table that is still guessed at costs a second
 * migration rather than an edit, which is why the pool's state-machine columns
 * wait for C5.
 *
 * `app_meta` is not decoration: it is what proves the write path works end to
 * end at boot, which is otherwise untested until the first domain table exists.
 */

export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** The single operator (ADR-0008). The repository, not SQL, keeps it to one row. */
export const authCredential = sqliteTable('auth_credential', {
  id: text('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  instanceName: text('instance_name').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Console sessions. Only the hash of the cookie value is stored (R5.10). */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  secretHash: text('secret_hash').notNull().unique(),
  modelsAllowed: text('models_allowed', { mode: 'json' }).$type<string[]>().notNull().default([]),
  modelsDenied: text('models_denied', { mode: 'json' }).$type<string[]>().notNull().default([]),
  budgetRequests: integer('budget_requests'),
  budgetTokens: integer('budget_tokens'),
  tpsLimit: integer('tps_limit'),
  rateLimitPerMinute: integer('rate_limit_per_minute'),
  expiresAt: text('expires_at'),
  clientRouterDenylist: text('client_router_denylist', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  /** v2 multi-user hook: who created this key. Null while there is one operator. */
  createdBy: text('created_by'),
  revokedAt: text('revoked_at'),
  lastUsedAt: text('last_used_at'),
  usageRequests: integer('usage_requests').notNull().default(0),
  usageInputTokens: integer('usage_input_tokens').notNull().default(0),
  usageOutputTokens: integer('usage_output_tokens').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

/**
 * A provider account (C3b2): the row a credential lives in.
 *
 * `credentialEnvelope` is the one column with no read path — written by the
 * sign-in, read by the pool, never handed to a route (R5.10). The state machine
 * that decides whether an account is routable adds its columns in C5; what is
 * here is only what the sign-in itself writes.
 */
export const providerAccounts = sqliteTable('provider_accounts', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull(),
  label: text('label').notNull(),
  credentialEnvelope: text('credential_envelope').notNull(),
  authMode: text('auth_mode').notNull(),
  emailMasked: text('email_masked'),
  state: text('state').notNull().default('active'),
  stateReason: text('state_reason'),
  maxInFlight: integer('max_in_flight').notNull().default(1),
  /**
   * The pool's mirror of the live in-flight count. The pool holds the truth in
   * memory and writes this so the console has a column to read; a restart clears
   * both, which is right — no request outlives the process that sent it.
   */
  inFlight: integer('in_flight').notNull().default(0),
  /** Set while `state` is `rate_limited` or `exhausted`; the recovery sweep reads it. */
  cooldownUntil: text('cooldown_until'),
  /** Reset on success. Drives the `error` state's escalation. */
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastUsedAt: text('last_used_at'),
  /** What the provider last reported about this account's window (FR-3.6). */
  quotaWindowSeconds: integer('quota_window_seconds'),
  quotaLimit: real('quota_limit'),
  quotaRemaining: real('quota_remaining'),
  quotaResetAt: text('quota_reset_at'),
  creditBalance: real('credit_balance'),
  creditCurrency: text('credit_currency'),
  note: text('note'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Aliases, combos and model mappings (C5b, FR-1.3–1.5): the three records that
 * decide what a client's model name actually means.
 *
 * They are separate tables rather than one polymorphic "rule" table because they
 * are read at three different points of one resolution and their shapes have
 * nothing in common — a mapping has a match mode and a priority, a combo owns a
 * child list, an alias is a single edge. One table would mean every reader
 * filtering on a discriminator to find the columns that apply to it.
 *
 * None of these is read in a hot loop: `plan/resolver.ts` loads all three once
 * per turn, and an instance holds tens of rows, not millions.
 */

/** A friendly name that resolves to a real model id (FR-1.3). */
export const aliases = sqliteTable('aliases', {
  id: text('id').primaryKey(),
  /** Unique across the instance: two aliases named `fast` would be ambiguous. */
  alias: text('alias').notNull().unique(),
  target: text('target').notNull(),
  /** Pins resolution to one provider; null means "whoever curates the id". */
  providerId: text('provider_id'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  description: text('description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** An ordered fallback chain presented to clients as one model (FR-1.4). */
export const combos = sqliteTable('combos', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  displayName: text('display_name').notNull(),
  description: text('description'),
  strategy: text('strategy').notNull().default('sequential'),
  /** Try the next entry when this one fails; off means fail fast. */
  fallbackOnError: integer('fallback_on_error', { mode: 'boolean' }).notNull().default(true),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * One step in a combo.
 *
 * `position` is stored rather than inferred from insertion order: SQLite offers
 * no row order without an `order by`, and the order of these rows *is* the
 * meaning of a sequential combo. Re-saving the list rewrites every position, so
 * the column describes the current chain and not when a row was added.
 */
export const comboEntries = sqliteTable('combo_entries', {
  id: text('id').primaryKey(),
  comboId: text('combo_id').notNull(),
  model: text('model').notNull(),
  providerId: text('provider_id'),
  weight: real('weight').notNull().default(1),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  position: integer('position').notNull(),
});

/**
 * Per-request telemetry (C6, FR-12.2–12.4): one row per `/v1` turn.
 *
 * Every read model in the Overview section derives from this table, so it is the
 * one place a usage number comes from. The rows expire on
 * `telemetryRetentionMinutes`, which is what keeps a single-user instance's
 * database bounded without a rollup table to keep in step.
 *
 * The nullable columns are the honest ones: a turn that failed before a provider
 * was chosen has no provider, a non-streaming turn has no time-to-first-token,
 * and a provider that reported no usage leaves the token columns null rather
 * than zero — averaging an unmeasured zero in would drag the mean.
 */
export const requests = sqliteTable('requests', {
  id: text('id').primaryKey(),
  at: text('at').notNull(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  providerId: text('provider_id'),
  model: text('model'),
  accountId: text('account_id'),
  apiKeyId: text('api_key_id'),
  status: integer('status').notNull(),
  errorKind: text('error_kind'),
  latencyMs: real('latency_ms').notNull(),
  /** Null for a non-streaming turn, and for one that failed before its first chunk. */
  ttftMs: real('ttft_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cachedInputTokens: integer('cached_input_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  /** Null when the model carries no price, so "free" and "unpriced" differ. */
  costUsd: real('cost_usd'),
  streamed: integer('streamed', { mode: 'boolean' }).notNull().default(false),
  requestId: text('request_id'),
  /**
   * What the Token Saver removed from this turn (C14), or null when the pipeline
   * never ran. One JSON document rather than a child table — see migration `0016`
   * for why, and `telemetry/savings.ts` for the shape and how it is read back.
   */
  tokenSaverSavings: text('token_saver_savings'),
});

/**
 * Redacted payload captures (SEC-6).
 *
 * Separate from `requests` because they are large and short-lived: a capture
 * lives 15 minutes while its request row lives for the retention window, so one
 * table would force the sweep to either delete telemetry too early or keep
 * bodies too long.
 *
 * The repository redacts before it inserts, so a body in this table has already
 * been through the secret scrubber — the column is the result, not the input.
 */
export const requestCaptures = sqliteTable('request_captures', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  stage: text('stage').notNull(),
  body: text('body').notNull(),
  byteSize: integer('byte_size').notNull(),
  truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
  redacted: integer('redacted', { mode: 'boolean' }).notNull().default(false),
  capturedAt: text('captured_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

/**
 * The automation's egress pool (C7a, FR-5.x).
 *
 * A bulk import drives a browser somewhere, and where it goes from matters: the
 * same sign-in attempted from the operator's own address a hundred times is the
 * pattern a provider blocks. So a job pins a proxy from this pool, and this table
 * is the pool.
 *
 * `credentialEnvelope` is the `SecretBox` envelope of a `username:password` pair,
 * never the pair (R5.10) — the read model carries `hasAuth` and nothing else. The
 * repository never holds a box, for the same reason `provider_accounts` does not:
 * decrypting is a decision about whether a credential is still good, and that
 * belongs to the prober.
 *
 * `health` defaults to `untested` rather than to a verdict, and `lastCheckedAt`
 * staying null is what proves it: a proxy added a second ago and a proxy that was
 * checked and failed are different facts, and the page shows them differently.
 */
export const proxies = sqliteTable('proxies', {
  id: text('id').primaryKey(),
  protocol: text('protocol').notNull().default('http'),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  credentialEnvelope: text('credential_envelope'),
  health: text('health').notNull().default('untested'),
  latencyMs: real('latency_ms'),
  lastCheckedAt: text('last_checked_at'),
  /** How many dispatches have left through this egress. A counter, not a log. */
  dispatchCount: integer('dispatch_count').notNull().default(0),
  note: text('note'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * SMS activation keys (C7a, FR-5.x).
 *
 * A `bulk-regist` job creates accounts rather than signing them in, so each one
 * needs a number it can receive a single code on. That number is rented per
 * attempt from one of these services, which makes this a credential pool shaped
 * exactly like the proxy one: masked read model, encrypted secret, a health
 * column a check-in refreshes.
 *
 * `country`/`operator`/`product` are the triple the last registration used, kept
 * so a job can default to something that already worked instead of asking the
 * operator to retype it. `successCount`/`failCount` are per-key tallies the
 * summary tiles read — a key that rents numbers but never receives a code is the
 * one an operator needs to see.
 */
export const smsProviders = sqliteTable('sms_providers', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull().default('5sim'),
  label: text('label').notNull(),
  credentialEnvelope: text('credential_envelope'),
  /** `first4••••last4`, or null before a key was set. Never the key. */
  keyHint: text('key_hint'),
  status: text('status').notNull().default('untested'),
  balance: real('balance'),
  currency: text('currency'),
  country: text('country'),
  operator: text('operator'),
  product: text('product'),
  successCount: integer('success_count').notNull().default(0),
  failCount: integer('fail_count').notNull().default(0),
  lastCheckedAt: text('last_checked_at'),
  note: text('note'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * One automation run (C7b, FR-5.x).
 *
 * A batch of credentials driven through a provider's sign-in by one worker
 * process. The counters are the run's own tally; the ledger is in `job_items`.
 *
 * `payloadEnvelope` is the batch's credentials, encrypted with the same box the
 * provider accounts use. A bulk import cannot run without them, and keeping them
 * is what lets `retry_failed` work after a restart. They are never in a read
 * model — the contract carries masked labels and counters and nothing else.
 *
 * `manualDeadlineAt` is the host's clock, not the worker's: the countdown the
 * operator watches and the clock that abandons a blocked item have to be the same
 * one, and only the host has a clock the console can read.
 */
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull(),
  method: text('method').notNull(),
  /** Null for a method that never opens a browser, such as a token import. */
  engine: text('engine'),
  mode: text('mode'),
  proxyId: text('proxy_id'),
  status: text('status').notNull().default('queued'),
  /** What the operator asked for. The machine may hold it lower (FR-5.8). */
  concurrency: integer('concurrency').notNull().default(1),
  /** What it actually runs at, when the machine held it down. Null when granted. */
  effectiveConcurrency: integer('effective_concurrency'),
  /** `bulk-regist` only: the key that rents the numbers. */
  smsProviderId: text('sms_provider_id'),
  /** `bulk-regist` only: how many accounts the job was asked to create. */
  quantity: integer('quantity'),
  total: integer('total').notNull().default(0),
  succeeded: integer('succeeded').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  needsManual: integer('needs_manual').notNull().default(0),
  manualWorkerId: text('manual_worker_id'),
  manualDeadlineAt: text('manual_deadline_at'),
  payloadEnvelope: text('payload_envelope'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  updatedAt: text('updated_at').notNull(),
});

/**
 * One credential in a batch.
 *
 * `attempts` is the worker's count, mirrored: the worker runs the retry loop
 * because it is the process that can see whether an attempt failed in a way worth
 * retrying. The column exists so the ledger survives a crash mid-item.
 *
 * There is no steps column. A step is streamed over the socket the moment it
 * happens and is not written down — a two-hundred-account batch at eight steps
 * each would be sixteen hundred rows kept for a reader who is not watching. A
 * live job's steps live in the manager's memory; what survives a restart is which
 * items ran, how many times, and how they ended.
 */
export const jobItems = sqliteTable('job_items', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  position: integer('position').notNull(),
  accountLabel: text('account_label').notNull(),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  lastError: text('last_error'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  updatedAt: text('updated_at').notNull(),
});

/**
 * The virtual-card pool (C8, FR-11.2).
 *
 * Cards are minted in batches and drawn down as provider sign-ups need one, so
 * the row tracks what a card is *doing* rather than who owns it.
 *
 * `panEnvelope` and `cvvEnvelope` are `SecretBox` envelopes and the read model
 * never carries them — a console that listed every number would be a
 * cardholder-data store with a UI. `maskedNumber` is what the table shows and
 * `last4` is the searchable key; the reveal endpoint is the one path that reads
 * an envelope, one card at a time.
 *
 * `hasPan` is a column rather than a derivation: a card an operator recorded by
 * hand from a masked form has no envelope, and "no number held" is a fact the UI
 * needs to hide the reveal button rather than offer one that fails.
 */
export const vccCards = sqliteTable('vcc_cards', {
  id: text('id').primaryKey(),
  brand: text('brand').notNull(),
  bin: text('bin').notNull(),
  last4: text('last4').notNull(),
  maskedNumber: text('masked_number').notNull(),
  panEnvelope: text('pan_envelope'),
  cvvEnvelope: text('cvv_envelope'),
  hasPan: integer('has_pan', { mode: 'boolean' }).notNull().default(false),
  expiryMonth: integer('expiry_month').notNull(),
  expiryYear: integer('expiry_year').notNull(),
  holderName: text('holder_name').notNull(),
  country: text('country'),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('active'),
  source: text('source').notNull(),
  assignedTo: text('assigned_to'),
  note: text('note'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Client-supplied content filter rules (C8, FR-11.3).
 *
 * A rule is one thing that happens at one of two moments, which is why `phase`
 * is a column rather than two tables: an operator moving a rule between phases is
 * editing it, not moving it between homes.
 *
 * `position` orders rules within a phase, and it is stored rather than derived
 * from insertion order because the order decides which rule a `block` walk
 * reaches first — a decision the operator made, and one that should survive an
 * unrelated edit to a neighbouring rule.
 */
export const filterRules = sqliteTable('filter_rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  pattern: text('pattern').notNull(),
  action: text('action').notNull(),
  /** 1 runs before compression, 2 after (FR-11.3). */
  phase: integer('phase').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Chat sessions (C9, FR-7.7).
 *
 * The session is the conversation's settings and its name; the transcript is a
 * separate table because the two have different lifetimes — a session is renamed
 * and re-pointed at a different model, while its messages only ever accumulate.
 * Keeping the messages in a column would mean rewriting the whole conversation
 * every time a turn lands.
 */
export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  providerId: text('provider_id'),
  model: text('model'),
  thinkingLevel: text('thinking_level').notNull().default('auto'),
  systemPrompt: text('system_prompt'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * One turn in a transcript (C9, FR-7.2).
 *
 * `content` and `attachments` are JSON: they hold the canonical content blocks
 * and the attachment blobs the contract already defines, and nothing queries
 * inside them — a message is read whole or not at all.
 *
 * `position` orders the session's messages, and it is stored rather than derived
 * from `createdAt` because two messages in the same millisecond are ordinary
 * here: the user's turn and the assistant's reply are written moments apart, and
 * an order that depends on a tie-break is an order that can flip.
 */
export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  position: integer('position').notNull(),
  role: text('role').notNull(),
  content: text('content', { mode: 'json' }).$type<ContentBlock[]>().notNull(),
  attachments: text('attachments', { mode: 'json' })
    .$type<ChatAttachment[]>()
    .notNull()
    .default([]),
  /** The timing block under an assistant turn (FR-7.9). Null for a user turn. */
  meta: text('meta', { mode: 'json' }).$type<ChatMessageMeta | null>(),
  /** Set when this turn was branched from another message (FR-7.8). */
  parentMessageId: text('parent_message_id'),
  createdAt: text('created_at').notNull(),
});

/**
 * One Studio render (C10, FR-8.x).
 *
 * A request, not a file: a failed render is still a row, because the prompt and
 * the settings are the expensive part to retype and the console can load a
 * failed job back into the composer. `asset_id` is filled once one comes out.
 *
 * `progress` is `real`: a diffusion run reports 0.37, and rounding that here
 * would be a loss the console cannot undo.
 */
export const studioGenerations = sqliteTable('studio_generations', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('queued'),
  providerId: text('provider_id').notNull(),
  model: text('model').notNull(),
  prompt: text('prompt').notNull(),
  negativePrompt: text('negative_prompt'),
  progress: real('progress'),
  stage: text('stage'),
  assetId: text('asset_id'),
  error: text('error'),
  parameters: text('parameters', { mode: 'json' })
    .$type<Record<string, string | number | boolean>>()
    .notNull()
    .default({}),
  parentAssetId: text('parent_asset_id'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});

/**
 * One file a render produced (C10, FR-8.4).
 *
 * The bytes live on disk — a five-second video is several megabytes, and SQLite
 * copies a BLOB through the page cache on every read. This row holds the
 * metadata and the **extension**; the file is `<dataDir>/studio/<id>.<extension>`.
 *
 * The extension is stored and the filename is not, and that is a safety property
 * rather than a preference: a `file_name` column would hold a string the provider
 * chose and would end up joined to a path. Building the path from an id rutekit
 * minted itself means no external string can name a directory.
 */
export const studioAssets = sqliteTable('studio_assets', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  mimeType: text('mime_type').notNull(),
  extension: text('extension').notNull(),
  thumbnailExtension: text('thumbnail_extension'),
  byteSize: integer('byte_size').notNull(),
  width: integer('width'),
  height: integer('height'),
  durationSeconds: real('duration_seconds'),
  providerId: text('provider_id').notNull(),
  model: text('model').notNull(),
  prompt: text('prompt').notNull(),
  negativePrompt: text('negative_prompt'),
  parameters: text('parameters', { mode: 'json' })
    .$type<Record<string, string | number | boolean>>()
    .notNull()
    .default({}),
  parentAssetId: text('parent_asset_id'),
  favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
});

/**
 * One benchmark experiment (C11, FR-9.1).
 *
 * The declaration rather than the data: a template, the variants it expanded to,
 * the targets it will be sent to, and the rubric each answer is scored against.
 * All four are fixed at creation, so they are JSON here — nothing queries inside
 * them and a cell that wanted to know what it was scored on reads the run.
 *
 * `workspace_dir` is where promptfoo's config, output and cache live for this
 * run. It is stored rather than derived so a failed run can be looked at
 * afterwards, and so a cleanup sweep knows what to remove.
 */
export const benchmarkRuns = sqliteTable('benchmark_runs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('queued'),
  template: text('template').notNull(),
  variants: text('variants', { mode: 'json' }).$type<BenchmarkVariant[]>().notNull().default([]),
  targets: text('targets', { mode: 'json' }).$type<BenchmarkTarget[]>().notNull().default([]),
  rubric: text('rubric', { mode: 'json' }).$type<BenchmarkAssertion[]>().notNull().default([]),
  systemPrompt: text('system_prompt'),
  expectedResultCount: integer('expected_result_count').notNull().default(0),
  error: text('error'),
  workspaceDir: text('workspace_dir'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});

/**
 * One cell of the matrix (C11, FR-9.2).
 *
 * `ttft_ms` and `latency_ms` are separate columns and are never combined: the
 * time to the first token and the time to the whole answer are different
 * quantities, and a schema with one column would make averaging them the obvious
 * thing to do.
 *
 * `position` is the cell's place in the matrix as it was built, so a page can
 * render a table in a stable order without re-deriving it from variant and
 * target — the same reason `chat_messages` stores its own.
 */
export const benchmarkResults = sqliteTable('benchmark_results', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  position: integer('position').notNull(),
  variantId: text('variant_id').notNull(),
  providerId: text('provider_id').notNull(),
  model: text('model').notNull(),
  status: text('status').notNull(),
  ttftMs: real('ttft_ms'),
  latencyMs: real('latency_ms'),
  outputTokens: integer('output_tokens'),
  tokensPerSecond: real('tokens_per_second'),
  costUsd: real('cost_usd'),
  qualityScore: real('quality_score'),
  outputPreview: text('output_preview').notNull().default(''),
  error: text('error'),
});

/**
 * One verification verdict about one endpoint (C12, FR-10.1–10.4).
 *
 * `posterior` and `signals` are JSON: both are written once with the row and read
 * whole, and neither is filtered or sorted by. A result whose posterior is
 * missing would be a verdict with no evidence behind it, which is the one shape
 * this feature must never produce — so they are written in the same statement.
 */
export const verificationResults = sqliteTable('verification_results', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull(),
  model: text('model').notNull(),
  claimedFamily: text('claimed_family').notNull(),
  verdict: text('verdict').notNull(),
  confidence: real('confidence').notNull().default(0),
  posterior: text('posterior', { mode: 'json' }).$type<FamilyPosterior[]>().notNull().default([]),
  signals: text('signals', { mode: 'json' }).$type<ProbeSignal[]>().notNull().default([]),
  probesUsed: integer('probes_used').notNull().default(0),
  durationMs: real('duration_ms').notNull().default(0),
  notes: text('notes'),
  createdAt: text('created_at').notNull(),
});

/**
 * A reference distribution, measured from an endpoint the operator trusts.
 *
 * Keyed by `(subject, probe_id)`: one subject — a family name or a model id —
 * holds one distribution per probe. `is_family` is stored rather than derived
 * from the subject string, because nothing about `gpt-4o` says it is a model and
 * nothing about `openai` says it is a family; and which one it is decides what a
 * verdict can claim, since a family baseline can never confirm an exact model.
 */
export const verificationBaselines = sqliteTable(
  'verification_baselines',
  {
    subject: text('subject').notNull(),
    probeId: text('probe_id').notNull(),
    isFamily: integer('is_family', { mode: 'boolean' }).notNull().default(false),
    distribution: text('distribution', { mode: 'json' })
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    samples: integer('samples').notNull().default(0),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    calibratedAt: text('calibrated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.subject, table.probeId] })],
);

/**
 * A BYOK provider an operator configured (C13a, FR-2.4).
 *
 * The catalogue's own providers are manifests and are immutable; a row here is
 * one the operator made, so it is the only kind `PATCH` and `DELETE` will touch.
 * The registry reads both, which is what makes a BYOK provider reachable by the
 * router rather than a row only the console can see.
 *
 * The credential is deliberately absent: a provider describes an endpoint, and
 * the key that opens it is an account, stored through the encrypted path every
 * other credential uses.
 */
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  category: text('category').notNull(),
  wireFamily: text('wire_family').notNull(),
  baseUrl: text('base_url'),
  docsUrl: text('docs_url'),
  icon: text('icon').notNull().default('box'),
  freeTier: integer('free_tier', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * A model that is not the catalogue's (C13a, FR-2.6).
 *
 * `custom` is an operator's own entry — rutekit owns it, so it can be edited and
 * removed. `synced` is what an endpoint answered the last time its models were
 * fetched: the provider's claim, so not editable, because the next fetch would
 * overwrite it. The catalogue's `template` entries are manifests and are not
 * rows at all, which is the contract's `modelSourceSchema` made structural.
 */
export const providerModels = sqliteTable(
  'provider_models',
  {
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    source: text('source').notNull(),
    displayName: text('display_name').notNull(),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    capabilities: text('capabilities', { mode: 'json' })
      .$type<{ vision: boolean; tools: boolean; reasoning: boolean; embedding: boolean }>()
      .notNull()
      .default({ vision: false, tools: false, reasoning: false, embedding: false }),
    inputPricePerMTok: real('input_price_per_mtok'),
    outputPricePerMTok: real('output_price_per_mtok'),
    deprecated: integer('deprecated', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.modelId] })],
);

/** A rewrite rule applied to the incoming model id before routing (FR-1.5). */
export const modelMappings = sqliteTable('model_mappings', {
  id: text('id').primaryKey(),
  match: text('match').notNull(),
  pattern: text('pattern').notNull(),
  replacement: text('replacement').notNull(),
  /** Lower numbers run first; ties keep the order the rows were created in. */
  priority: integer('priority').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  description: text('description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
