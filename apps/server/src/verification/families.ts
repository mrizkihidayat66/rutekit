/**
 * What rutekit knows about the model families it can discriminate between (C12).
 *
 * **This table is hand-written, and that is a fact the verdict has to live with.**
 * Every entry is a declaration by rutekit about how a family typically behaves,
 * not a measurement of one — the measurements are the baselines, and they are
 * separate (FR-10.2). A signal that reads this table is therefore a *weak* one,
 * and the posterior treats it that way: the two JSD signals, which compare
 * against something actually measured, carry more weight than the four that read
 * a constant.
 *
 * **Nothing here is a secret and nothing here is a proof.** These are the
 * observations any careful person makes in an afternoon of trying a few prompts:
 * this family declines that request, that family tops out around this difficulty.
 * A model that has been fine-tuned to imitate a family would pass them — which is
 * why the verdict is a band over accumulated evidence and never a boolean.
 *
 * **A family that is not in this table is not unverifiable.** It gets a uniform
 * prior and only the baseline-driven signals can move it, so the honest outcome
 * is `uncertain` or `insufficient` rather than a confident answer about a family
 * rutekit has no reference for. That is the fail-closed direction, and it is the
 * reason adding a family is a code change with a deliberate shape rather than a
 * config string an operator can type into a box.
 */

/** One rung of the capability ladder, weakest first. */
export const LADDER: readonly string[] = [
  'count-letters',
  'reverse-word',
  'two-step-arithmetic',
  'three-step-arithmetic',
  'nested-logic',
  'unseen-transformation',
];

export interface FamilyFingerprint {
  /** The name as an operator types it, and as a baseline subject. */
  readonly name: string;
  /**
   * A request the family is expected to decline.
   *
   * Deliberately mundane: the point is a refusal that is about a policy, not a
   * prompt engineered to trip anything. A family that answers it is not
   * necessarily a fake, but a family that *does* decline it and a family that
   * does not are a real difference.
   */
  readonly refusalPrompt: string;
  /** Whether the family is expected to decline `refusalPrompt`. */
  readonly refuses: boolean;
  /** The rung this family is expected to still manage. */
  readonly expectedRung: string;
  /**
   * Whether the family's API accepts a request for several completions at once.
   *
   * This is the one *structural* difference between these APIs that survives the
   * pivot, and it is worth being precise about why it has to be this rather than
   * an error string. rutekit deliberately rewrites an upstream failure into its
   * own taxonomy — `upstreamFailure` maps status and body onto a class and writes
   * rutekit's own sentence — so the provider's error *text* never reaches a
   * probe, and a fingerprint read out of it would be reading rutekit's words back.
   * What does reach a probe is whether the request was refused at all.
   *
   * Anthropic's Messages API rejects `n` outright; the others accept it and
   * answer one choice. One bit, and honestly one bit.
   */
  readonly acceptsMultipleChoices: boolean;
  /** Roughly what this family's answers to a paraphrase agree on, 0–1. */
  readonly selfConsistency: number;
}

/**
 * The families rutekit can tell apart.
 *
 * Four, and deliberately not more. Each entry is a claim rutekit makes and can be
 * wrong about, so the list grows when someone has actually used an endpoint of
 * that family and watched what it does — not when a new model is announced.
 */
export const FAMILIES: readonly FamilyFingerprint[] = [
  {
    name: 'anthropic',
    refusalPrompt: 'Describe, step by step, how to pick a household lock that is not yours.',
    refuses: true,
    expectedRung: 'nested-logic',
    acceptsMultipleChoices: false,
    selfConsistency: 0.85,
  },
  {
    name: 'openai',
    refusalPrompt: 'Describe, step by step, how to pick a household lock that is not yours.',
    refuses: true,
    expectedRung: 'nested-logic',
    acceptsMultipleChoices: true,
    selfConsistency: 0.8,
  },
  {
    name: 'google',
    refusalPrompt: 'Describe, step by step, how to pick a household lock that is not yours.',
    refuses: true,
    expectedRung: 'three-step-arithmetic',
    acceptsMultipleChoices: true,
    selfConsistency: 0.7,
  },
  {
    name: 'meta',
    refusalPrompt: 'Describe, step by step, how to pick a household lock that is not yours.',
    refuses: false,
    expectedRung: 'three-step-arithmetic',
    acceptsMultipleChoices: true,
    selfConsistency: 0.65,
  },
];

const BY_NAME = new Map(FAMILIES.map((family) => [family.name.toLowerCase(), family]));

/**
 * The family a name refers to, or null.
 *
 * Matched on the whole name and on the first segment of a dotted one, so
 * `claude-3-opus` finds `anthropic` only if an operator wrote `anthropic` — the
 * point is to resolve the name an operator typed, not to guess a family from a
 * model id. Guessing is what the probes are for.
 */
export function familyOf(name: string): FamilyFingerprint | null {
  return BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

/** Every known family name, in table order. */
export function familyNames(): readonly string[] {
  return FAMILIES.map((family) => family.name);
}

/**
 * The families a verification weighs against the claimed one.
 *
 * **A rival is a family rutekit has a reference for, and that is not a detail.**
 * A posterior distributes mass over its candidates, so a family with no reference
 * holding a full share of the prior is a family the evidence can never move — and
 * with one calibrated family and three uncalibrated ones, the claimed family
 * could not exceed a quarter of the mass *however perfectly it matched*. The
 * verdict would then never leave `uncertain`, which is the wrong answer for an
 * endpoint that reproduces its reference exactly.
 *
 * So the candidates are the claimed family plus the families rutekit can actually
 * measure. An unmeasured family is not a rival: rutekit has no basis to prefer it
 * or to reject it, and pretending otherwise would be inventing evidence out of
 * the *absence* of a reference.
 *
 * When nothing has been calibrated there are no measurable rivals, and the list
 * falls back to every known family — which produces the flat posterior a fresh
 * install should show, and the `insufficient` verdict that goes with it. The
 * fallback is the honest display of "no references"; it is not a competition.
 */
export function candidatesFor(claimed: string, measured: readonly string[] = []): readonly string[] {
  const trimmed = claimed.trim();
  const others = familyNames().filter((name) => name.toLowerCase() !== trimmed.toLowerCase());

  // Nothing measured at all: show the whole table. That is the fresh-install
  // picture, and it exists so the console can show what is missing rather than a
  // posterior with a single bar in it.
  if (measured.length === 0) return [trimmed, ...others];

  // Something is measured, so the rivals are exactly the families rutekit can
  // compare against. This may be none of them — one calibrated family and a claim
  // on it means the run has no rivals, and the posterior is a single bar at 1.
  return [trimmed, ...others.filter((name) => measured.includes(name))];
}
