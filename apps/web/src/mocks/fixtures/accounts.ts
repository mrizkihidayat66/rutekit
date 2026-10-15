import type { Account, AccountState } from '@contracts';

import { daysAgo, hoursAgo, hoursFromNow, minutesAgo, minutesFromNow } from '../clock.ts';
import { type Rng } from '../random.ts';
import { PROVIDER_CATALOG, type ProviderSeed } from './provider-catalog.ts';

/**
 * The pool is the most interesting fixture in the app: the Accounts page, the
 * Quota page and the Dashboard tiles all read it, so the state distribution is
 * chosen to look like a pool that is working. Most accounts are `active`, the
 * non-active ones are spread thinly across the remaining six states, and every
 * one of the seven is represented so no badge renders untested.
 */
const STATE_WEIGHTS: readonly (readonly [AccountState, number])[] = [
  ['active', 62],
  ['rate_limited', 11],
  ['exhausted', 8],
  ['error', 7],
  ['disabled', 5],
  ['banned', 4],
  ['pending', 3],
];

const FIRST_NAMES = [
  'alex',
  'jordan',
  'sam',
  'riley',
  'casey',
  'morgan',
  'taylor',
  'devon',
  'quinn',
  'avery',
  'rowan',
  'skyler',
  'harper',
  'emerson',
  'finley',
  'jamie',
  'kai',
  'noah',
  'luca',
  'mika',
] as const;

const LAST_NAMES = [
  'nguyen',
  'patel',
  'silva',
  'okafor',
  'haddad',
  'kim',
  'rossi',
  'ivanov',
  'yamada',
  'costa',
  'novak',
  'eriksen',
  'diallo',
  'moreau',
  'santos',
] as const;

const EMAIL_DOMAINS = [
  'gmail.com',
  'outlook.com',
  'proton.me',
  'yahoo.com',
  'icloud.com',
  'fastmail.com',
] as const;

/** Operator-facing reason, phrased the way the Accounts table shows it. */
const STATE_REASONS: Readonly<Record<AccountState, string | null>> = {
  active: null,
  rate_limited: 'Upstream returned 429; cooling down until the window resets.',
  exhausted: 'Quota window consumed; waiting for the scheduled reset.',
  error: 'Three consecutive upstream failures; parked for warmup.',
  disabled: 'Paused by an operator.',
  banned: 'Provider rejected the credential; needs a fresh sign-in.',
  pending: 'Imported, awaiting first successful check-in.',
};

function maskedEmail(rng: Rng, person: string): string {
  const handle = person.toLowerCase().replace(/[^a-z]/g, '');
  const head = handle.slice(0, 1);
  const tail = handle.slice(-1);
  return `${head}***${tail}@${rng.pick(EMAIL_DOMAINS)}`;
}

/** Providers that actually hold a credential pool, as opposed to a fixed key. */
function poolsAccounts(provider: ProviderSeed): boolean {
  if (provider.category === 'api-key' || provider.category === 'oauth') return true;
  if (provider.category === 'aggregator') return true;
  return provider.capabilities.automation;
}

/**
 * `forced` overrides the weighted draw, so `buildAccounts` can guarantee a state
 * is present. Every state-dependent field below is derived from `state` rather
 * than drawn separately, which is what makes the override safe: a forced `banned`
 * account gets the banned reason and the banned last-used date too, instead of a
 * row whose badge disagrees with its own detail fields.
 */
function buildAccount(
  rng: Rng,
  provider: ProviderSeed,
  index: number,
  forced?: AccountState,
): Account {
  const state = forced ?? rng.weighted(STATE_WEIGHTS);
  const person = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
  const maxInFlight = rng.pick([1, 1, 2, 3, 4]);
  const windowSeconds = rng.pick([3600, 21_600, 86_400, 604_800]);
  const limit = rng.pick([100, 500, 1000, 5000, 20_000]);
  const remaining = state === 'exhausted' ? 0 : rng.int(Math.ceil(limit * 0.04), limit);
  const asCredit = rng.bool(0.16);
  const cooling = state === 'rate_limited' || state === 'exhausted';

  return {
    id: `acct_${provider.id}_${String(index + 1).padStart(2, '0')}`,
    providerId: provider.id,
    label: `${person} (${provider.name})`,
    emailMasked: maskedEmail(rng, person),
    state,
    stateReason: STATE_REASONS[state],
    inFlight: state === 'active' ? rng.int(0, maxInFlight) : 0,
    maxInFlight,
    cooldownUntil: cooling
      ? state === 'exhausted'
        ? hoursFromNow(rng.int(1, 20))
        : minutesFromNow(rng.int(2, 45))
      : null,
    quota: {
      windowSeconds,
      limit: asCredit ? null : limit,
      remaining: asCredit ? null : remaining,
      resetAt: hoursFromNow(rng.int(1, 24)),
      creditBalance: asCredit ? rng.round(rng.float(1, 240), 2) : null,
      creditCurrency: asCredit ? 'USD' : null,
    },
    consecutiveFailures: state === 'active' ? 0 : rng.int(1, 6),
    lastUsedAt: state === 'disabled' || state === 'banned' ? daysAgo(rng.int(1, 9)) : minutesAgo(rng.int(1, 240)),
    note: rng.bool(0.12) ? rng.pick(['Purchased in the March batch.', 'Do not rotate before the audit.', 'Shared with the batch importer.']) : null,
    createdAt: daysAgo(rng.int(3, 90)),
    updatedAt: hoursAgo(rng.int(1, 72)),
  };
}

/**
 * Roughly eighty accounts spread over the providers that hold pools. The count
 * per provider is weighted so the big aggregators look busier than a local
 * Ollama box, which is what an operator would actually see.
 *
 * The weights alone do not guarantee a state appears: `banned` and `pending` are
 * rare enough that a given seed can produce none of them, and a missing state is
 * not a cosmetic gap — it leaves a badge variant, a filter option, a state reason
 * and one arm of every state-shaped branch in the UI with nothing to render. So
 * the pass below checks what the draw produced and rebuilds one account per
 * missing state, taken from the `active` majority. It is one extra loop over a
 * few dozen rows, and it makes the fixture's guarantee a fact rather than a hope.
 */
export function buildAccounts(rng: Rng): Account[] {
  const accounts: Account[] = [];
  const slots: { readonly provider: ProviderSeed; readonly index: number }[] = [];

  for (const provider of PROVIDER_CATALOG) {
    if (!poolsAccounts(provider)) continue;
    const busy = provider.category === 'aggregator' || provider.id === 'openai' || provider.id === 'anthropic';
    const count = busy ? rng.int(4, 7) : rng.int(3, 6);
    for (let index = 0; index < count; index += 1) {
      accounts.push(buildAccount(rng, provider, index));
      slots.push({ provider, index });
    }
  }

  const present = new Set(accounts.map((account) => account.state));
  for (const [state] of STATE_WEIGHTS) {
    if (present.has(state)) continue;
    const at = accounts.findIndex((account) => account.state === 'active');
    const slot = at === -1 ? undefined : slots[at];
    // No `active` left to give up means the draw was already unusual; leaving it
    // alone beats throwing over fixture data.
    if (slot === undefined) continue;
    accounts[at] = buildAccount(rng, slot.provider, slot.index, state);
    present.add(state);
  }

  return accounts;
}
