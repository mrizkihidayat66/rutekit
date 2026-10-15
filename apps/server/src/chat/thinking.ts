import type { ThinkingLevel, WireFamily } from '@contracts';

/**
 * The console's thinking level, in the provider's own vocabulary (FR-7.10).
 *
 * The console offers one scale — auto, low, medium, high, xhigh, max — and the
 * four wire families spell reasoning three different ways, none of them a scale
 * with six rungs. Something has to be the translation, and it belongs here rather
 * than in a codec: a codec renders the *pivot*, and the pivot has no reasoning
 * column at all (see `ingest/messages.ts`). What the level becomes is a fact about
 * a request a person configured, not about a dialect.
 *
 * **It travels in `extras`, which every codec spreads verbatim into its body.**
 * That is the pivot's own escape hatch for parameters it does not model, and it is
 * what makes this a four-line function instead of a schema change. It is also why
 * the keys below are the providers' own — `reasoning_effort`, `thinking` — rather
 * than anything rutekit invented.
 *
 * **A model that cannot think never sees any of it.** The turn computes the
 * request's demands and the model's declared capabilities, and `degrade` removes
 * the reasoning extras for a model whose manifest does not claim `reasoning` — the
 * same path that drops images for a model that cannot see them. That is what keeps
 * `reasoning_effort` off a plain `gpt-4o`, which would answer it with a 400.
 *
 * Two families are missing, for reasons rather than by omission:
 *
 *   - **Google** wants `generationConfig.thinkingConfig`, and `extras` are spread
 *     at the top level — so a key set here would be overwritten by the codec's own
 *     `generationConfig`, which is assigned after the spread. Reaching inside it
 *     needs the codec to know about thinking, or the manifest to declare how it is
 *     spelled. That is a change to the manifest schema (ADR-0018), not to this
 *     function, and it is the right follow-up rather than a hack here.
 *   - **`custom`** has no codec at all, so there is no body to put a key in.
 *
 * `auto` sends nothing anywhere: it means "whatever the model does by default",
 * and inventing a level for it would be answering a question the operator
 * deliberately left open.
 */

/** What the request needs for one thinking level. */
export interface ReasoningAsk {
  /** Keys for the pivot's `extras`, spread into the provider's body verbatim. */
  readonly extras: Readonly<Record<string, unknown>>;
  /**
   * A `max_tokens` the family's reasoning requires, or null when it needs none.
   *
   * Anthropic refuses a thinking budget that is not below `max_tokens`, and the
   * codec's own default (4096) is below every budget here — so a level that thinks
   * has to state a ceiling with room for the answer above the budget, or the
   * request is rejected before the model ever sees it.
   */
  readonly maxTokens: number | null;
}

/** A level that asks for something. `auto` is the one that asks for nothing. */
type AskedLevel = Exclude<ThinkingLevel, 'auto'>;

/**
 * Effort, for the family whose reasoning is named rather than measured.
 *
 * OpenAI has three rungs where the console has five, so the two above `high` clamp
 * to it. Clamping rather than refusing is deliberate: `max` is an operator asking
 * for "as much as this model can", and a model that tops out at `high` has
 * answered that request rather than refused it.
 */
const EFFORT: Readonly<Record<AskedLevel, 'low' | 'medium' | 'high'>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

/**
 * Budgets in tokens, for the family whose reasoning is measured rather than named.
 *
 * These numbers are rutekit's, not a provider's: Anthropic asks for a budget and
 * publishes no table of levels, so the six rungs have to land somewhere. They are
 * spaced by a factor of two so a level is a visible change rather than a nudge,
 * and the top is well inside what a current Claude model will accept as
 * `max_tokens`.
 */
const BUDGET: Readonly<Record<AskedLevel, number>> = {
  low: 1024,
  medium: 2048,
  high: 4096,
  xhigh: 8192,
  max: 16384,
};

/** Room for the answer above the budget, for the family that counts both. */
const ANSWER_HEADROOM = 8192;

export function reasoningAsk(family: WireFamily, level: ThinkingLevel): ReasoningAsk {
  if (level === 'auto') return NOTHING;

  switch (family) {
    case 'openai':
      return { extras: { reasoning_effort: EFFORT[level] }, maxTokens: null };
    case 'anthropic': {
      const budget = BUDGET[level];
      return {
        extras: { thinking: { type: 'enabled', budget_tokens: budget } },
        maxTokens: budget + ANSWER_HEADROOM,
      };
    }
    case 'google':
    case 'custom':
      return NOTHING;
  }
}

const NOTHING: ReasoningAsk = { extras: {}, maxTokens: null };
