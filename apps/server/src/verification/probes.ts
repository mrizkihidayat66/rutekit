import type { ProbeSignalKind } from '@contracts';

import { LADDER } from './families.ts';

/**
 * The probes a verification runs, and what each one costs (C12, FR-10.1).
 *
 * A probe is one request. The method is query-bounded — a first-token
 * distribution needs tens of samples before a divergence from a reference means
 * anything — so the catalogue declares its costs and the budgets scale them,
 * rather than the run spending whatever it happens to spend.
 *
 * **Every probe reads something the pivot can actually see.** That is a harder
 * constraint than it sounds: rutekit receives *canonical* events, not the
 * provider's own bytes, so a probe cannot look at a raw frame, a header, or a
 * logprob. What survives the pivot is the answer's text, the first token, the
 * usage numbers, the timings, and whether a request was refused at all. Every
 * probe below is built from those and nothing else.
 *
 * The `api-surface` probe is where that constraint bites hardest, and it is worth
 * saying what it is *not*: it does not read the provider's error vocabulary,
 * because rutekit rewrites an upstream failure into its own sentence before
 * anything sees it (`upstreamFailure`). A fingerprint read out of an error string
 * would be reading rutekit's words back. What the probe reads instead is
 * **whether a request the family's API is known to refuse was refused** — one
 * bit, and an honest one.
 *
 * **Two probes need a baseline and four do not.** The two that do compare a
 * distribution against something measured (`dist-main`, `dist-unicode`); the
 * other four read the curated table in `families.ts` and are therefore weaker
 * evidence. The posterior weights them accordingly.
 */

export type Budget = 'quick' | 'standard' | 'deep';

/** How a probe's answers are turned into an observation. */
export type Reading =
  | 'first-token-distribution'
  | 'refusal'
  | 'ladder'
  | 'agreement'
  | 'parameter-acceptance';

export interface ProbeSpec {
  readonly id: string;
  readonly kind: ProbeSignalKind;
  readonly label: string;
  readonly reading: Reading;
  /** The prompts sent, in order. Each is sampled `samples` times. */
  readonly prompts: readonly string[];
  /** Requests per prompt. One for a single-shot probe. */
  readonly samples: number;
  readonly temperature: number;
  readonly maxTokens: number;
}

/** How much of each budget goes where. */
interface Allocation {
  readonly distSamples: number;
  readonly ladderRungs: number;
  /** How many of the paraphrase prompts to send, capped by how many exist. */
  readonly paraphrasePrompts: number;
}

/**
 * The three budgets.
 *
 * `standard` is the method's own figure: roughly a hundred requests, which is
 * what the single-token distribution needs to be worth computing. `quick` is a
 * first look at an endpoint that may not answer at all — it deliberately spends
 * too few samples for a divergence to mean anything, and the signal says so
 * rather than reporting a number computed from six points. `deep` buys more
 * samples per prompt rather than more prompts, because the two distribution
 * probes are the only ones whose precision improves with volume.
 *
 * The counts these produce are mirrored in `PROBE_BUDGET_COUNTS` in the contract,
 * where the console reads them to show the price before it is paid; a test
 * asserts the two against each other so they cannot drift.
 */
const ALLOCATIONS: Readonly<Record<Budget, Allocation>> = {
  quick: { distSamples: 6, ladderRungs: 3, paraphrasePrompts: 2 },
  standard: { distSamples: 40, ladderRungs: 6, paraphrasePrompts: 4 },
  deep: { distSamples: 88, ladderRungs: 6, paraphrasePrompts: 4 },
};

/**
 * The fewest samples a divergence may be computed from.
 *
 * Below this the signal reports itself unusable rather than reporting a number.
 * A JSD over six draws is a comparison of two lists of one or two tokens each,
 * and it would read as confident evidence in the console — which is exactly the
 * failure this threshold exists to prevent.
 */
export const MIN_DISTRIBUTION_SAMPLES = 24;

/** The two prompts whose first tokens are compared against a reference. */
const DIST_PROMPTS = {
  /** Ordinary prose: the tokens a model reaches for when nothing constrains it. */
  main: 'Complete this sentence with one word: The capital of France is',
  /**
   * Whitespace and non-Latin script, where tokenizers disagree most.
   *
   * The second JSD probe is the same measurement over a different input rather
   * than a different method — cheap, and orthogonal enough to be worth its cost.
   */
  unicode: 'Complete this with one word, in Japanese: ありがとう と 言',
} as const;

/** One rung of the ladder, as a prompt the model either manages or does not. */
function rungPrompt(rung: string): string {
  switch (rung) {
    case 'count-letters':
      return 'How many times does the letter "r" appear in "strawberry"? Answer with the number only.';
    case 'reverse-word':
      return 'Write the word "lighthouse" backwards. Answer with the word only.';
    case 'two-step-arithmetic':
      return 'A box holds 7 rows of 6 apples. Four are removed. How many remain? Answer with the number only.';
    case 'three-step-arithmetic':
      return 'A train travels 45 km in 30 minutes, waits 10 minutes, then travels 30 km in 20 minutes. What is its average speed over the whole journey in km/h? Answer with the number only.';
    case 'nested-logic':
      return 'All bloops are razzies. No razzies are green. Is it possible for a bloop to be green? Answer yes or no, then one sentence.';
    case 'unseen-transformation':
      return 'Define the transformation T on a string: reverse it, then replace every vowel with the letter that follows it in the alphabet. Apply T to "orbit". Answer with the result only.';
    default:
      return `Demonstrate the following ability in one short sentence: ${rung}.`;
  }
}

/**
 * One question asked several ways, for the agreement probe.
 *
 * The answer is the same under every phrasing, which is the point: what is being
 * measured is whether the endpoint *agrees with itself* across paraphrases, not
 * whether it can multiply. Four phrasings is the ceiling every budget shares —
 * more would cost requests without making the split-half comparison sharper, and
 * the split is what the measure is made of.
 */
const PARAPHRASES: readonly string[] = [
  'What is 17 multiplied by 23? Answer with the number only.',
  'Compute the product of seventeen and twenty-three. Reply with just the number.',
  'Multiply 17 by 23 and give only the result.',
  '17 × 23 = ? Answer with the number alone.',
];

/** The prompt the acceptance probe sends. Ordinary; the request around it is not. */
export const ACCEPTANCE_PROMPT = 'Say the word "ok".';

/**
 * The probes for a budget.
 *
 * Built rather than declared so the counts follow from the allocation in one
 * place — a catalogue that hard-coded forty samples in two spots would drift the
 * first time a budget changed.
 */
export function probesFor(budget: Budget): readonly ProbeSpec[] {
  const allocation = ALLOCATIONS[budget];
  const rungs = LADDER.slice(0, allocation.ladderRungs);

  return [
    {
      id: 'dist-main',
      kind: 'single-token-distribution',
      label: 'Single-token distribution',
      reading: 'first-token-distribution',
      prompts: [DIST_PROMPTS.main],
      samples: allocation.distSamples,
      // Temperature above zero is what makes a distribution exist at all: at zero
      // the same prompt returns the same token every time, and the measurement
      // would be a single value compared against a single value.
      temperature: 1,
      maxTokens: 4,
    },
    {
      id: 'dist-unicode',
      kind: 'tokenizer-surface',
      label: 'Tokenizer surface',
      reading: 'first-token-distribution',
      prompts: [DIST_PROMPTS.unicode],
      samples: allocation.distSamples,
      temperature: 1,
      maxTokens: 4,
    },
    {
      id: 'refusal',
      kind: 'negative-control',
      label: 'Negative control',
      reading: 'refusal',
      prompts: ['{{refusal}}'],
      samples: 1,
      // Zero, because this is a question about what the model chooses to do, not
      // about how it phrases it. A distribution over refusals is not a signal.
      temperature: 0,
      maxTokens: 160,
    },
    {
      id: 'acceptance',
      kind: 'api-surface',
      label: 'API surface',
      reading: 'parameter-acceptance',
      prompts: [ACCEPTANCE_PROMPT],
      samples: 1,
      temperature: 0,
      maxTokens: 4,
    },
    {
      id: 'ladder',
      kind: 'capability-boundary',
      label: 'Capability boundary',
      reading: 'ladder',
      prompts: rungs.map(rungPrompt),
      samples: 1,
      temperature: 0,
      maxTokens: 120,
    },
    {
      id: 'paraphrase',
      kind: 'self-consistency',
      label: 'Self-consistency',
      reading: 'agreement',
      prompts: PARAPHRASES.slice(0, allocation.paraphrasePrompts),
      samples: 1,
      temperature: 0,
      maxTokens: 12,
    },
  ];
}

/** How many requests a budget spends, without running anything. */
export function probeCount(budget: Budget): number {
  return probesFor(budget).reduce(
    (total, probe) => total + probe.prompts.length * probe.samples,
    0,
  );
}
