import type {
  BrowserEngine,
  Job,
  JobItem,
  JobMethod,
  JobMode,
  JobStatus,
  JobStep,
  Proxy,
  ProxyHealth,
  ProxyProtocol,
  SmsProvider,
  SmsProviderStatus,
} from '@contracts';

import { daysAgo, hoursAgo, minutesAgo, minutesFromNow } from '../clock.ts';
import { type Rng } from '../random.ts';

/**
 * Automation fixtures exist so every job state is on screen at once — the
 * Automation Logs page is a history view, and a history with only `succeeded`
 * in it would never exercise the timeline, the manual-captcha panel or the
 * retry bar. One job per terminal state, plus a running one and one parked in
 * `needs_manual` with a live deadline.
 */

/** A line of a job's timeline, and what to say while it is the current one. */
interface StepSpec {
  readonly name: string;
  /** Picked from while this step is in flight or has just ended. */
  readonly notes?: readonly string[];
  /** The step that parks on a person. At most one per list. */
  readonly manual?: boolean;
}

/**
 * The timeline differs by method, because the work does: a sign-in drives a
 * browser through a form, a registration rents a number before it can fill one
 * in, and a token import never opens a browser at all. Reusing one list would
 * have a token job announce "Launch browser" as its first step, which is a lie
 * the drawer would show an operator plainly.
 */
const SIGN_IN_STEPS: readonly StepSpec[] = [
  { name: 'Launch browser' },
  { name: 'Open sign-in page' },
  { name: 'Submit credentials' },
  {
    name: 'Detect challenge',
    notes: ['No challenge presented.', 'Turnstile widget detected.', 'Image grid challenge presented.'],
  },
  {
    name: 'Await manual solution',
    notes: ['Waiting for an operator to solve the challenge in the live preview.'],
    manual: true,
  },
  { name: 'Confirm session' },
  { name: 'Read API key' },
  { name: 'Persist credential' },
];

const REGISTER_STEPS: readonly StepSpec[] = [
  { name: 'Launch browser' },
  { name: 'Rent a number', notes: ['Holding a number for two minutes.', 'The first number was already taken.'] },
  { name: 'Open sign-up page' },
  { name: 'Submit details' },
  {
    name: 'Solve the challenge',
    notes: ['Waiting for an operator to solve the challenge in the live preview.'],
    manual: true,
  },
  { name: 'Await the code', notes: ['Waiting on the activation service.', 'The code arrived on the second SMS.'] },
  { name: 'Read API key' },
  { name: 'Persist credential' },
];

const TOKEN_STEPS: readonly StepSpec[] = [
  { name: 'Parse the batch' },
  { name: 'Verify the token', notes: ['The provider accepted the token.', 'Checked against the models endpoint.'] },
  { name: 'Persist credential' },
];

const FAILURE_NOTES = [
  'Timed out after 30s.',
  'The provider rejected the credentials (401).',
  'The preview stream closed unexpectedly.',
] as const;

function maskedAccount(rng: Rng): string {
  const heads = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'j', 'k', 'm', 'n', 'p', 'r', 's', 't'];
  const domains = ['gmail.com', 'outlook.com', 'proton.me', 'yahoo.com'];
  const head = rng.pick(heads);
  const tail = rng.pick(heads);
  const digits = rng.int(1, 99);
  return `${head}***${tail}${digits}@${rng.pick(domains)}`;
}

/**
 * How many of a batch's steps an item of this status has got through, as a
 * count rather than an index so the same status reads the same way on a
 * three-step token import and an eight-step sign-in.
 */
function reachedCount(status: JobStatus, count: number): number {
  switch (status) {
    case 'queued':
      return 0;
    case 'running':
      return Math.max(1, Math.round(count * 0.5));
    case 'needs_manual':
      return Math.max(1, Math.round(count * 0.62));
    case 'paused':
      return Math.max(1, Math.round(count * 0.38));
    case 'succeeded':
      return count;
    case 'failed':
      return Math.max(1, Math.round(count * 0.62));
    case 'cancelled':
      return Math.max(1, Math.round(count * 0.25));
  }
}

function buildSteps(rng: Rng, status: JobStatus, baseMs: number, specs: readonly StepSpec[]): JobStep[] {
  const reached = reachedCount(status, specs.length);
  const steps: JobStep[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    if (spec === undefined) continue;
    const before = index < reached - 1;
    const current = index === reached - 1;

    let stepStatus: JobStep['status'] = 'pending';
    if (before) stepStatus = 'ok';
    else if (current) {
      if (status === 'failed') stepStatus = 'failed';
      else if (status === 'needs_manual') stepStatus = 'running';
      else if (status === 'succeeded') stepStatus = 'ok';
      else if (status === 'running') stepStatus = 'running';
      else if (status === 'paused') stepStatus = 'running';
      else if (status === 'cancelled') stepStatus = 'skipped';
    } else if (status === 'failed') {
      stepStatus = 'skipped';
    }

    const startedAt = stepStatus === 'pending' ? null : new Date(baseMs + index * rng.int(700, 4200)).toISOString();
    const finishedAt =
      stepStatus === 'ok' || stepStatus === 'failed' || stepStatus === 'skipped'
        ? new Date(baseMs + index * rng.int(700, 4200) + rng.int(300, 5200)).toISOString()
        : null;

    let detail: string | null = null;
    if (stepStatus === 'failed') detail = rng.pick(FAILURE_NOTES);
    else if (spec.notes !== undefined && stepStatus !== 'pending') detail = rng.pick(spec.notes);

    steps.push({
      id: `stp_${index}_${rng.id('s').slice(2)}`,
      index,
      name: spec.name,
      status: stepStatus,
      detail,
      startedAt,
      finishedAt,
      screenshotId: detail !== null && spec.notes !== undefined ? rng.id('shot') : null,
    });
  }
  return steps;
}

function buildItems(
  rng: Rng,
  jobStatus: JobStatus,
  total: number,
  maxAttempts: number,
  specs: readonly StepSpec[],
): JobItem[] {
  const items: JobItem[] = [];
  const succeededTarget = jobStatus === 'succeeded' ? total : Math.floor(total * rng.float(0.3, 0.8));
  for (let index = 0; index < total; index += 1) {
    let status: JobStatus;
    if (jobStatus === 'succeeded') status = 'succeeded';
    else if (jobStatus === 'failed') status = index < total - 1 ? 'succeeded' : 'failed';
    else if (jobStatus === 'queued') status = 'queued';
    else if (jobStatus === 'running') status = index < succeededTarget ? 'succeeded' : 'running';
    else if (jobStatus === 'needs_manual') status = index < succeededTarget ? 'succeeded' : 'needs_manual';
    else if (jobStatus === 'paused') status = index < succeededTarget ? 'succeeded' : 'paused';
    else status = index < 1 ? 'succeeded' : 'cancelled';

    const baseMs = Date.now() - rng.int(2, 90) * 60_000;
    const attempts = status === 'failed' ? maxAttempts : rng.int(1, maxAttempts);
    items.push({
      id: `jitem_${index}_${rng.id('i').slice(2)}`,
      accountLabel: maskedAccount(rng),
      status,
      attempts,
      maxAttempts,
      lastError: status === 'failed' ? rng.pick(['Challenge not solved before the deadline.', 'Sign-in rejected.', 'Proxy refused the connection.']) : null,
      startedAt: status === 'queued' ? null : new Date(baseMs).toISOString(),
      finishedAt: status === 'succeeded' || status === 'failed' || status === 'cancelled' ? new Date(baseMs + rng.int(9_000, 48_000)).toISOString() : null,
      steps: buildSteps(rng, status, baseMs, specs),
    });
  }
  return items;
}

/** Which timeline a method's browsers walk. */
function stepsFor(method: JobMethod): readonly StepSpec[] {
  switch (method) {
    case 'bulk-login':
      return SIGN_IN_STEPS;
    case 'bulk-regist':
      return REGISTER_STEPS;
    case 'bulk-token':
      return TOKEN_STEPS;
  }
}

interface JobPlan {
  readonly providerId: string;
  readonly method: JobMethod;
  readonly status: JobStatus;
  /** Null for `bulk-token`, which never opens a browser. */
  readonly engine: BrowserEngine | null;
  /** Null whenever `engine` is. */
  readonly mode: JobMode | null;
  readonly concurrency: number;
  readonly total: number;
  /**
   * An id from the proxy pool, or null when the job let the router choose. The
   * pool is generated separately, so this is the id format rather than a lookup
   * — the two fixtures are seeded independently and neither is built from the
   * other.
   */
  readonly proxyId: string | null;
}

export function buildJobs(rng: Rng): Job[] {
  const plan: readonly JobPlan[] = [
    { providerId: 'kiro', method: 'bulk-login', status: 'running', engine: 'chromium', mode: 'headless', concurrency: 3, total: 12, proxyId: 'proxy_004' },
    { providerId: 'codebuddy-cn', method: 'bulk-regist', status: 'needs_manual', engine: 'camoufox', mode: 'headed', concurrency: 2, total: 8, proxyId: 'proxy_011' },
    { providerId: 'qoder', method: 'bulk-login', status: 'succeeded', engine: 'chromium', mode: 'headless', concurrency: 4, total: 20, proxyId: 'proxy_002' },
    { providerId: 'codebuddy-intl', method: 'bulk-token', status: 'succeeded', engine: null, mode: null, concurrency: 4, total: 20, proxyId: null },
    { providerId: 'kiro', method: 'bulk-login', status: 'failed', engine: 'chromium', mode: 'headless', concurrency: 1, total: 5, proxyId: 'proxy_017' },
    { providerId: 'qoder', method: 'bulk-login', status: 'paused', engine: 'camoufox', mode: 'headed', concurrency: 2, total: 10, proxyId: null },
    { providerId: 'codebuddy-cn', method: 'bulk-regist', status: 'queued', engine: 'chromium', mode: 'headless', concurrency: 2, total: 16, proxyId: 'proxy_009' },
    { providerId: 'codebuddy-intl', method: 'bulk-login', status: 'succeeded', engine: 'chromium', mode: 'headless', concurrency: 3, total: 24, proxyId: 'proxy_005' },
    { providerId: 'kiro', method: 'bulk-login', status: 'cancelled', engine: 'camoufox', mode: 'headless', concurrency: 1, total: 6, proxyId: null },
    { providerId: 'codebuddy-cn', method: 'bulk-token', status: 'succeeded', engine: null, mode: null, concurrency: 2, total: 9, proxyId: null },
    { providerId: 'qoder', method: 'bulk-login', status: 'failed', engine: 'chromium', mode: 'headless', concurrency: 2, total: 7, proxyId: 'proxy_021' },
    { providerId: 'codebuddy-intl', method: 'bulk-login', status: 'running', engine: 'chromium', mode: 'headless', concurrency: 1, total: 4, proxyId: 'proxy_013' },
  ];

  return plan.map((entry, index) => {
    const maxAttempts = rng.int(2, 4);
    const specs = stepsFor(entry.method);
    const items = buildItems(rng, entry.status, entry.total, maxAttempts, specs);
    const succeeded = items.filter((item) => item.status === 'succeeded').length;
    const failed = items.filter((item) => item.status === 'failed').length;
    const needsManual = items.filter((item) => item.status === 'needs_manual').length;
    const createdAt = hoursAgo(rng.int(2, 96));
    const active = entry.status === 'running' || entry.status === 'needs_manual' || entry.status === 'paused';

    return {
      id: `job_${String(index + 1).padStart(3, '0')}_${entry.providerId}`,
      providerId: entry.providerId,
      method: entry.method,
      engine: entry.engine,
      mode: entry.mode,
      proxyId: entry.proxyId,
      status: entry.status,
      concurrency: entry.concurrency,
      // No machine is measured in a fixture, so nothing is ever capped — which is
      // the ordinary case the field exists to be null in.
      effectiveConcurrency: null,
      total: entry.total,
      succeeded,
      failed,
      needsManual,
      manualWorkerId: needsManual > 0 ? `worker_${rng.int(1, entry.concurrency)}` : null,
      manualDeadlineAt: entry.status === 'needs_manual' ? minutesFromNow(rng.int(2, 8)) : null,
      items,
      createdAt,
      startedAt: entry.status === 'queued' ? null : hoursAgo(rng.int(1, 90)),
      finishedAt: active ? null : minutesAgo(rng.int(5, 600)),
    };
  });
}

const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5'];

function buildProxy(rng: Rng, index: number): Proxy {
  const protocol = rng.pick(PROXY_PROTOCOLS);
  const health: ProxyHealth = rng.weighted<ProxyHealth>([
    ['healthy', 55],
    ['slow', 20],
    ['dead', 15],
    ['untested', 10],
  ]);
  const octets = `${rng.int(24, 210)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
  const hasAuth = rng.bool(0.7);
  return {
    id: `proxy_${String(index + 1).padStart(3, '0')}`,
    protocol,
    host: octets,
    port: rng.pick([1080, 3128, 8000, 8080, 8888, 9050, 4145, 10001]),
    hasAuth,
    health,
    latencyMs: health === 'untested' ? null : health === 'dead' ? null : health === 'slow' ? rng.int(900, 4200) : rng.int(28, 340),
    lastCheckedAt: health === 'untested' ? null : minutesAgo(rng.int(1, 720)),
    dispatchCount: rng.int(0, 4800),
    note: rng.bool(0.25) ? rng.pick(['Residential pool, EU exit.', 'Datacenter, fast but flagged sometimes.', 'Sticky session for 10 minutes.', 'Cheap and flaky; keep as last resort.']) : null,
    createdAt: daysAgo(rng.int(1, 120)),
    updatedAt: hoursAgo(rng.int(1, 200)),
  };
}

export function buildProxies(rng: Rng): Proxy[] {
  return Array.from({ length: 26 }, (_value, index) => buildProxy(rng, index));
}

/**
 * The activation keys a `bulk-regist` job rents numbers with.
 *
 * Every status the pool can hold is represented, because each one is a different
 * thing for the operator to do about it: an `active` key is left alone, an
 * `untested` one has never been asked, a `disabled` one was switched off by hand,
 * and an `error` one was refused. A pool of nothing but `active` keys would make
 * the summary tiles look like decoration.
 *
 * `keyHint` is the masked shape the read model returns — the plaintext key never
 * exists in the mock at all, which is the same reason `maskAccount` drops a
 * password: a fixture that held the secret would let a handler leak it by
 * accident.
 */
const SMS_PLANS: readonly {
  readonly label: string;
  readonly status: SmsProviderStatus;
  readonly balance: number | null;
  readonly success: number;
  readonly fail: number;
  readonly triple: readonly [string, string, string] | null;
  readonly note: string | null;
}[] = [
  { label: '5sim — main', status: 'active', balance: 4180.5, success: 312, fail: 24, triple: ['russia', 'any', 'codebuddy'], note: 'Topped up monthly; the one registrations run on.' },
  { label: '5sim — overflow', status: 'active', balance: 940.25, success: 88, fail: 11, triple: ['indonesia', 'any', 'codebuddy'], note: null },
  { label: '5sim — cheap tier', status: 'active', balance: 132.75, success: 61, fail: 39, triple: ['philippines', 'any', 'codebuddy'], note: 'Numbers are slow to arrive; keep only for volume.' },
  { label: '5sim — CN routes', status: 'active', balance: 2610, success: 144, fail: 9, triple: ['china', 'virtual51', 'codebuddy'], note: 'The only key that reaches the CN registrations.' },
  { label: '5sim — backup', status: 'untested', balance: null, success: 0, fail: 0, triple: null, note: 'Bought but never used.' },
  { label: '5sim — spare', status: 'untested', balance: null, success: 0, fail: 0, triple: null, note: null },
  { label: '5sim — old account', status: 'disabled', balance: 76.4, success: 205, fail: 63, triple: ['russia', 'any', 'codebuddy'], note: 'Held back while the seller dispute is open.' },
  { label: '5sim — trial', status: 'disabled', balance: 0, success: 4, fail: 2, triple: null, note: null },
  { label: '5sim — revoked', status: 'error', balance: null, success: 51, fail: 47, triple: ['india', 'any', 'codebuddy'], note: 'The key was rotated upstream and this one stopped answering.' },
  { label: '5sim — dry', status: 'error', balance: 0, success: 118, fail: 6, triple: ['russia', 'any', 'codebuddy'], note: 'Ran to zero mid-batch.' },
];

/** A masked key, in the `first4••••last4` shape the read model promises. */
function keyHint(rng: Rng): string {
  const alphabet = 'abcdef0123456789';
  const chunk = (length: number) =>
    Array.from({ length }, () => alphabet[rng.int(0, alphabet.length - 1)] ?? 'a').join('');
  return `${chunk(4)}••••${chunk(4)}`;
}

export function buildSmsProviders(rng: Rng): SmsProvider[] {
  return SMS_PLANS.map((plan, index) => {
    const country = plan.triple?.[0] ?? null;
    const operator = plan.triple?.[1] ?? null;
    const product = plan.triple?.[2] ?? null;
    return {
      id: `sms_${String(index + 1).padStart(3, '0')}`,
      kind: '5sim',
      label: plan.label,
      keyHint: keyHint(rng),
      status: plan.status,
      balance: plan.balance,
      currency: plan.balance === null ? null : 'RUB',
      country,
      operator,
      product,
      successCount: plan.success,
      failCount: plan.fail,
      lastCheckedAt: plan.status === 'untested' ? null : minutesAgo(rng.int(3, 2_880)),
      note: plan.note,
      createdAt: daysAgo(rng.int(2, 200)),
      updatedAt: hoursAgo(rng.int(1, 240)),
    };
  });
}
