import type { Usage } from '@contracts';
import type { ManifestModel } from '@registry';

/**
 * What one turn cost, in USD (FR-12.4).
 *
 * The manifest is the price list: `inputPricePerMTok` and `outputPricePerMTok`
 * are USD per million tokens, declared per model, and the registry is where an
 * operator's own curation lives. So this is arithmetic over two numbers rutekit
 * already holds rather than a table of rates to keep in step with the providers.
 *
 * **Cached input is billed at the full input rate.** The manifest has one input
 * price and no cached rate, so a provider that discounts cached tokens will be
 * overestimated here. That is the honest direction to be wrong in: the figure is
 * a budget signal, and an operator who acts on a number that is slightly high
 * spends less than they planned rather than more. A second price column would
 * fix it and is worth adding when a provider's own billing needs to be matched
 * to the cent.
 *
 * **Null, not zero, when the model carries no price.** A locally hosted model has
 * no per-token cost and a model whose price rutekit has not learned has an
 * unknown one, and those are different facts — a chart that showed both as `$0`
 * would claim the second is free. The caller stores the null and the contract
 * carries it.
 *
 * Pure: usage and a model in, a number or null out.
 */

const TOKENS_PER_MTOK = 1_000_000;

export function costOf(model: ManifestModel, usage: Usage): number | null {
  const input = model.inputPricePerMTok;
  const output = model.outputPricePerMTok;
  if (input === null && output === null) return null;

  const inputCost = ((input ?? 0) * usage.inputTokens) / TOKENS_PER_MTOK;
  const outputCost = ((output ?? 0) * usage.outputTokens) / TOKENS_PER_MTOK;

  // Rounded to six decimals — a millionth of a cent — so a stored figure does not
  // carry float noise into a sum the console shows to two places anyway.
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
