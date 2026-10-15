import { http } from '../net.ts';
import type {
  Job,
  JobItem,
  Proxy,
  ProxyHealth,
  ProxyProtocol,
  SmsProviderStatus,
} from '@contracts';
import {
  bulkResultSchema,
  jobControlBodySchema,
  jobInputSchema,
  jobManualBodySchema,
  jobSchema,
  jobSessionBodySchema,
  jobsResponseSchema,
  proxyCheckBodySchema,
  proxyCheckResultSchema,
  proxyImportBodySchema,
  proxyInputSchema,
  proxySchema,
  proxyUpdateSchema,
  proxiesResponseSchema,
  proxiesSummarySchema,
  smsProviderCheckBodySchema,
  smsProviderCheckResultSchema,
  smsProviderInputSchema,
  smsProviderSchema,
  smsProviderUpdateSchema,
  smsProvidersResponseSchema,
  smsProvidersSummarySchema,
} from '@contracts';

import { db, matches, paginate, sortBy } from '../db.ts';
import { isoAt, minutesFromNow } from '../clock.ts';
import {
  badRequest,
  bodyOf,
  listParams,
  notFound,
  ok,
  paramId,
  respond,
  route,
  searchParams,
  strParam,
  uid,
} from './helpers.ts';

/** Automation section: Automation, Automation Logs, Proxy Pool, SMS Providers. */

/**
 * A credential line as the operator should see it back: the address, never the
 * secret. The payload is `email:password`, so everything from the first colon on
 * is dropped rather than passed through — the page promises these are write-only,
 * and a label that echoed the password would make that promise a lie.
 */
function maskAccount(raw: string): string {
  const value = raw.trim();
  const at = value.indexOf('@');
  if (at <= 0) return value.length <= 3 ? '***' : `${value.slice(0, 2)}***`;
  const rest = value.slice(at + 1);
  return `${value.slice(0, 1)}***@${rest.split(':', 1)[0] ?? rest}`;
}

/**
 * What a registration job's item is called while it has no account yet.
 *
 * There is no credential to mask here — the number *is* the identity, and it is
 * the only thing the operator could usefully recognise the row by when a
 * registration fails.
 */
function rentedNumber(index: number): string {
  return `+1 (555) ${String(100 + index).padStart(3, '0')}-${String(1000 + index * 7).slice(-4)}`;
}

/** Stable pseudo-health from the host string, so a check is repeatable. */
function healthFor(host: string): { health: ProxyHealth; latencyMs: number | null } {
  let hash = 2166136261;
  for (let index = 0; index < host.length; index += 1) {
    hash ^= host.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const roll = (hash >>> 0) % 100;
  if (roll < 62) return { health: 'healthy', latencyMs: 40 + (roll * 3) };
  if (roll < 78) return { health: 'slow', latencyMs: 900 + (roll * 11) };
  if (roll < 90) return { health: 'dead', latencyMs: null };
  return { health: 'untested', latencyMs: null };
}

/** A freshly added proxy: never checked, never dispatched through. */
function makeProxy(input: {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  note: string | null;
}): Proxy {
  return {
    id: uid('proxy'),
    protocol: input.protocol,
    host: input.host,
    port: input.port,
    hasAuth: input.username !== null || input.password !== null,
    health: 'untested',
    latencyMs: null,
    lastCheckedAt: null,
    dispatchCount: 0,
    note: input.note,
    createdAt: isoAt(0),
    updatedAt: isoAt(0),
  };
}

/** The scheme a pasted line opens with, if it has one. */
const PROXY_SCHEME = /^(http|https|socks5):\/\//i;

interface ParsedProxyLine {
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
}

/**
 * Read one `protocol://user:pass@host:port` line from a bulk paste.
 *
 * A paste arrives in whatever shape the seller's list uses, so the scheme and
 * the credentials are both optional — `host:port` alone is the common case and
 * is read as plain HTTP. Splitting on the *last* `@` and the *last* `:` is what
 * keeps a password containing either character from truncating the host.
 *
 * The failure is a sentence rather than a boolean because it is shown back to
 * the operator against the line number that produced it.
 */
function parseProxyLine(raw: string): { readonly proxy: ParsedProxyLine } | { readonly error: string } {
  const line = raw.trim();
  if (line === '') return { error: 'empty line' };

  let rest = line;
  let protocol: ProxyProtocol = 'http';
  const scheme = PROXY_SCHEME.exec(line);
  const schemeName = scheme?.[1];
  if (scheme !== null && schemeName !== undefined) {
    const lowered = schemeName.toLowerCase();
    protocol = lowered === 'https' ? 'https' : lowered === 'socks5' ? 'socks5' : 'http';
    rest = line.slice(scheme[0].length);
  }

  let username: string | null = null;
  let password: string | null = null;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const credentials = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = credentials.indexOf(':');
    username = colon === -1 ? credentials : credentials.slice(0, colon);
    password = colon === -1 ? null : credentials.slice(colon + 1);
  }

  const portColon = rest.lastIndexOf(':');
  if (portColon === -1) return { error: 'no port — expected host:port' };
  const host = rest.slice(0, portColon);
  const port = Number.parseInt(rest.slice(portColon + 1), 10);
  if (host === '') return { error: 'no host' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'port must be a whole number between 1 and 65535' };
  }

  return { proxy: { protocol, host, port, username, password } };
}

/**
 * What asking the activation service about a key would come back with.
 *
 * Derived from the masked hint rather than drawn at random, so checking the same
 * key twice reports the same thing — a balance that changed every time you
 * looked would make the page look broken rather than live.
 *
 * A key an operator disabled stays disabled: a check reads the balance, it does
 * not overrule the person who switched it off. Everything else comes back either
 * answering with a balance or refusing, which is the one distinction the status
 * column exists to draw.
 */
function smsCheckFor(hint: string | null): {
  readonly status: SmsProviderStatus;
  readonly balance: number | null;
} {
  const source = hint ?? 'none';
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const roll = (hash >>> 0) % 100;
  if (roll < 78) return { status: 'active', balance: Math.round(roll * 37.5 * 100) / 100 };
  return { status: 'error', balance: null };
}

export const automationHandlers = [
  http.get(route('jobs'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const providerId = strParam(params, 'providerId');
    const status = strParam(params, 'status');
    const q = params.get('q') ?? '';

    let items = db.jobs;
    if (providerId !== null) items = items.filter((entry) => entry.providerId === providerId);
    if (status !== null) items = items.filter((entry) => entry.status === status);
    items = items.filter((entry) => matches([entry.id, entry.providerId, entry.engine, entry.method], q));

    return respond(jobsResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('jobs'), async ({ request }) => {
    const input = jobInputSchema.parse(await bodyOf(request));
    if (db.provider(input.providerId) === undefined) return badRequest(`unknown provider "${input.providerId}"`);
    const lines = input.payload
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    /**
     * Which fields carry meaning is decided by the method, so the guard is too.
     * A sign-in and a token import both read their batch out of `payload`; a
     * registration has no batch — it creates the accounts — and is refused when
     * it does not say how many to create or which key pays for the numbers.
     */
    if (input.method === 'bulk-regist') {
      if (input.quantity === null) return badRequest('a registration job needs a quantity');
      if (input.smsProviderId === null) return badRequest('a registration job needs an SMS provider');
    } else if (lines.length === 0) {
      return badRequest(
        input.method === 'bulk-login' ? 'payload contained no credentials' : 'payload contained no tokens',
      );
    }

    const labels =
      input.method === 'bulk-regist'
        ? Array.from({ length: input.quantity ?? 0 }, (_value, index) => rentedNumber(index))
        : lines.map((line) => maskAccount(line));

    const items: JobItem[] = labels.map((label) => ({
      id: uid('item'),
      accountLabel: label,
      status: 'queued',
      attempts: 0,
      maxAttempts: input.maxAttempts,
      lastError: null,
      startedAt: null,
      finishedAt: null,
      steps: [],
    }));
    const job: Job = {
      id: uid('job'),
      providerId: input.providerId,
      method: input.method,
      engine: input.engine,
      mode: input.mode,
      proxyId: input.proxyId,
      status: 'queued',
      concurrency: input.concurrency,
      // The mock has no machine to measure, so nothing is ever capped — which is
      // the ordinary case the field exists to be null in.
      effectiveConcurrency: null,
      total: items.length,
      succeeded: 0,
      failed: 0,
      needsManual: 0,
      manualWorkerId: null,
      manualDeadlineAt: null,
      items,
      createdAt: isoAt(0),
      startedAt: null,
      finishedAt: null,
    };
    db.jobs.unshift(job);
    return respond(jobSchema, job);
  }),

  http.get(route('job'), ({ params }) => {
    const job = db.job(paramId(params));
    return job === undefined ? notFound('job', paramId(params)) : respond(jobSchema, job);
  }),

  http.post(route('jobControl'), async ({ params, request }) => {
    const body = jobControlBodySchema.parse(await bodyOf(request));
    const updated = db.controlJob(paramId(params), body.action);
    return updated === undefined ? notFound('job', paramId(params)) : respond(jobSchema, updated);
  }),

  http.post(route('jobManual'), async ({ params, request }) => {
    const job = db.job(paramId(params));
    if (job === undefined) return notFound('job', paramId(params));
    const body = jobManualBodySchema.parse(await bodyOf(request));
    const item = job.items.find((entry) => entry.id === body.itemId);
    if (item === undefined) return notFound('job item', body.itemId);
    item.status = 'running';
    item.lastError = null;

    /**
     * The job's tally and deadline follow its items, not the other way round. One
     * answer frees one worker; if another is still parked the job is still
     * blocked, and it gets a fresh window rather than claiming to be clear.
     */
    const blocked = job.items.filter((entry) => entry.status === 'needs_manual').length;
    job.needsManual = blocked;
    job.status = blocked === 0 ? 'running' : 'needs_manual';
    job.manualWorkerId = blocked === 0 ? null : job.manualWorkerId;
    job.manualDeadlineAt = blocked === 0 ? null : minutesFromNow(2);
    return respond(jobSchema, job);
  }),

  /**
   * Open a manual session on one item (FR-5.7).
   *
   * The mock has no worker to re-capture the page, so what it can honestly
   * reproduce is the effect the console sees: the item is confirmed still parked,
   * and its deadline is pushed out — which is the point of the endpoint for
   * somebody who has just sat down to a challenge.
   */
  http.post(route('jobSession'), async ({ params, request }) => {
    const job = db.job(paramId(params));
    if (job === undefined) return notFound('job', paramId(params));
    const body = jobSessionBodySchema.parse(await bodyOf(request));
    const item = job.items.find((entry) => entry.id === body.itemId);
    if (item === undefined) return notFound('job item', body.itemId);
    if (item.status !== 'needs_manual') return badRequest('that item is not waiting for an answer');

    job.manualDeadlineAt = minutesFromNow(2);
    return respond(jobSchema, job);
  }),

  http.get(route('proxies'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const protocol = strParam(params, 'protocol');
    const health = strParam(params, 'health');
    const q = params.get('q') ?? '';

    let items = db.proxies;
    if (protocol !== null) items = items.filter((entry) => entry.protocol === protocol);
    if (health !== null) items = items.filter((entry) => entry.health === health);
    items = items.filter((entry) => matches([entry.host, entry.id, entry.note], q));

    return respond(proxiesResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('proxies'), async ({ request }) => {
    const input = proxyInputSchema.parse(await bodyOf(request));
    const proxy = makeProxy(input);
    db.proxies.unshift(proxy);
    return respond(proxySchema, proxy);
  }),

  /**
   * Health tallies for the pool's summary tiles.
   *
   * Registered ahead of `/proxies/:id` on purpose: MSW takes the first match, so
   * a parameterised route declared earlier would answer `summary` as an id.
   */
  http.get(route('proxiesSummary'), () => {
    const counts = { healthy: 0, slow: 0, dead: 0, untested: 0 };
    for (const proxy of db.proxies) counts[proxy.health] += 1;
    return respond(proxiesSummarySchema, { total: db.proxies.length, ...counts });
  }),

  /**
   * Bulk paste import. Partial success is the normal outcome — a list of two
   * hundred lines usually has one malformed — so each rejected line is reported
   * against its own line number instead of failing the whole paste.
   */
  http.post(route('proxiesImport'), async ({ request }) => {
    const body = proxyImportBodySchema.parse(await bodyOf(request));
    const lines = body.payload
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const errors: { id: string; message: string }[] = [];
    let succeeded = 0;

    lines.forEach((line, index) => {
      const parsed = parseProxyLine(line);
      if ('error' in parsed) {
        errors.push({ id: `line ${String(index + 1)}`, message: parsed.error });
        return;
      }
      db.proxies.unshift(makeProxy({ ...parsed.proxy, note: null }));
      succeeded += 1;
    });

    return respond(bulkResultSchema, {
      requested: lines.length,
      succeeded,
      failed: errors.length,
      errors,
    });
  }),

  http.post(route('proxiesCheck'), async ({ request }) => {
    const body = proxyCheckBodySchema.parse(await bodyOf(request));
    const targets = body.ids.length === 0 ? db.proxies.map((entry) => entry.id) : body.ids;
    const results: { id: string; health: ProxyHealth; latencyMs: number | null }[] = [];

    for (const id of targets) {
      const proxy = db.proxy(id);
      if (proxy === undefined) continue;
      const { health, latencyMs } = healthFor(proxy.host);
      db.updateProxy(id, { health, latencyMs, lastCheckedAt: isoAt(0) });
      results.push({ id, health, latencyMs });
    }

    return respond(proxyCheckResultSchema, { results });
  }),

  http.get(route('proxy'), ({ params }) => {
    const proxy = db.proxy(paramId(params));
    return proxy === undefined ? notFound('proxy', paramId(params)) : respond(proxySchema, proxy);
  }),

  http.patch(route('proxy'), async ({ params, request }) => {
    const patch = proxyUpdateSchema.parse(await bodyOf(request));
    const updated = db.updateProxy(paramId(params), {
      ...(patch.host === undefined ? {} : { host: patch.host }),
      ...(patch.port === undefined ? {} : { port: patch.port }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
      ...(patch.protocol === undefined ? {} : { protocol: patch.protocol }),
    });
    return updated === undefined ? notFound('proxy', paramId(params)) : respond(proxySchema, updated);
  }),

  http.delete(route('proxy'), ({ params }) => {
    const id = paramId(params);
    return db.removeProxy(id) ? ok() : notFound('proxy', id);
  }),

  http.get(route('smsProviders'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const kind = strParam(params, 'kind');
    const status = strParam(params, 'status');
    const q = params.get('q') ?? '';

    let items = db.smsProviders;
    if (kind !== null) items = items.filter((entry) => entry.kind === kind);
    if (status !== null) items = items.filter((entry) => entry.status === status);
    items = items.filter((entry) => matches([entry.label, entry.keyHint, entry.note], q));

    return respond(
      smsProvidersResponseSchema,
      paginate(sortBy(items, sort, direction), { cursor, limit }),
    );
  }),

  http.post(route('smsProviders'), async ({ request }) => {
    const input = smsProviderInputSchema.parse(await bodyOf(request));
    return respond(smsProviderSchema, db.createSmsProvider(input));
  }),

  /**
   * Balance tallies for the pool's summary tiles.
   *
   * Registered ahead of `/sms-providers/:id` on purpose: MSW takes the first
   * match, so a parameterised route declared earlier would answer `summary` as
   * an id — the same trap the proxy routes document.
   */
  http.get(route('smsProvidersSummary'), () => {
    const counts = { active: 0, disabled: 0, error: 0, untested: 0 };
    let successCount = 0;
    let failCount = 0;
    for (const provider of db.smsProviders) {
      counts[provider.status] += 1;
      successCount += provider.successCount;
      failCount += provider.failCount;
    }
    return respond(smsProvidersSummarySchema, {
      total: db.smsProviders.length,
      ...counts,
      successCount,
      failCount,
    });
  }),

  /** An empty `ids` means "check every key", the same convention proxies use. */
  http.post(route('smsProvidersCheck'), async ({ request }) => {
    const body = smsProviderCheckBodySchema.parse(await bodyOf(request));
    const targets =
      body.ids.length === 0 ? db.smsProviders.map((entry) => entry.id) : body.ids;
    const results: {
      id: string;
      status: SmsProviderStatus;
      balance: number | null;
      currency: string | null;
    }[] = [];

    for (const id of targets) {
      const provider = db.smsProvider(id);
      if (provider === undefined) continue;
      const read = smsCheckFor(provider.keyHint);
      const status = provider.status === 'disabled' ? 'disabled' : read.status;
      const balance = provider.status === 'disabled' ? provider.balance : read.balance;
      const currency = balance === null ? null : 'RUB';
      db.updateSmsProvider(id, { status, balance, currency, lastCheckedAt: isoAt(0) });
      results.push({ id, status, balance, currency });
    }

    return respond(smsProviderCheckResultSchema, { results });
  }),

  http.get(route('smsProvider'), ({ params }) => {
    const provider = db.smsProvider(paramId(params));
    return provider === undefined
      ? notFound('sms provider', paramId(params))
      : respond(smsProviderSchema, provider);
  }),

  /**
   * Edit the parts of a key that can be edited.
   *
   * `apiKey` is accepted by the schema and deliberately dropped here: the key is
   * write-only, so a patch that carried one would be a rotation, and rotation has
   * its own consequence (every in-flight job loses the number it is holding) that
   * an ordinary edit does not. The console never sends one.
   */
  http.patch(route('smsProvider'), async ({ params, request }) => {
    const patch = smsProviderUpdateSchema.parse(await bodyOf(request));
    const updated = db.updateSmsProvider(paramId(params), {
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.country === undefined ? {} : { country: patch.country }),
      ...(patch.operator === undefined ? {} : { operator: patch.operator }),
      ...(patch.product === undefined ? {} : { product: patch.product }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
    });
    return updated === undefined
      ? notFound('sms provider', paramId(params))
      : respond(smsProviderSchema, updated);
  }),

  http.delete(route('smsProvider'), ({ params }) => {
    const id = paramId(params);
    return db.removeSmsProvider(id) ? ok() : notFound('sms provider', id);
  }),
];
