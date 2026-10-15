import type { BenchmarkAssertion, BenchmarkTarget, BenchmarkVariant } from '@contracts';

/**
 * The promptfoo configuration a run is executed with (C11, FR-9.1).
 *
 * A run is a matrix — N variants of one template across M provider/model pairs —
 * and promptfoo's native model is `prompts × providers`. So the mapping is
 * direct: **each variant is a prompt, each target is a provider**, and the cells
 * promptfoo produces are exactly the cells the contract's `results` array holds.
 * Nothing is re-derived on the way out.
 *
 * **The document is JSON, and the file is still called `promptfooconfig.yaml`.**
 * YAML is a superset of JSON, so this parses identically — and `JSON.stringify`
 * cannot produce a malformed document for arbitrary prompt text, whereas
 * hand-rolled YAML escaping has exactly one failure mode that matters: a prompt
 * containing a line that looks like a key, a `-`, or a `#` silently becomes a
 * different document. The cost is that the file reads as JSON rather than YAML,
 * which is a cosmetic price for a document that cannot be wrong.
 *
 * **The labels are rutekit's own ids, not the operator's text.** A cell is mapped
 * back to its variant and target by reading `prompt.label` and `provider.label`,
 * so those two strings have to be unambiguous — a variant id and a target key,
 * both of which rutekit minted. Using a prompt's text or a model's display name
 * would make the mapping a guess the first time two things looked alike.
 *
 * **The rubric becomes promptfoo's `assert` list.** The three kinds the contract
 * declares map onto three assertion types promptfoo already has, which is why the
 * kinds were chosen the way they were: a `contains` is a `contains`, a `regex` is
 * a `regex` (a search, not a full match — the contract says "match somewhere"),
 * and a `max_length` is a one-line `javascript` assertion because promptfoo has no
 * length primitive and inventing one would be a promise rutekit cannot keep if
 * the engine is ever replaced.
 */

/** One cell of the matrix, as the run intends it. */
export interface PlannedCell {
  readonly variantId: string;
  readonly target: BenchmarkTarget;
  /** The cell's place in the matrix: variant-major, then target. */
  readonly position: number;
}

export interface BenchmarkPlan {
  /** The document to write as `promptfooconfig.yaml`. */
  readonly document: Record<string, unknown>;
  /** Every cell the run expects, in a stable order. */
  readonly cells: readonly PlannedCell[];
}

export interface PlanOptions {
  /** The instance's own origin, which the thin provider calls back into. */
  readonly baseUrl: string;
  /** The provider script's filename, relative to the workspace. */
  readonly providerFile: string;
  readonly systemPrompt: string | null;
  readonly rubric: readonly BenchmarkAssertion[];
  readonly thinkingLevel: string;
}

/** The key a cell is filed under: one target, spelled unambiguously. */
export function targetKey(target: BenchmarkTarget): string {
  return `${target.providerId}::${target.model}`;
}

/**
 * One rubric entry as promptfoo's assertion.
 *
 * `max_length` is `<=` rather than `<`: the contract says "longest acceptable
 * answer", and a limit of 100 refusing an answer of exactly 100 characters would
 * be off by one in the direction nobody expects.
 */
export function assertionFor(assertion: BenchmarkAssertion): Record<string, unknown> {
  switch (assertion.kind) {
    case 'contains':
      return { type: 'contains', value: assertion.value };
    case 'regex':
      return { type: 'regex', value: assertion.value };
    case 'max_length':
      return { type: 'javascript', value: `output.length <= ${String(assertion.value)}` };
  }
}

export function planRun(
  variants: readonly BenchmarkVariant[],
  targets: readonly BenchmarkTarget[],
  options: PlanOptions,
): BenchmarkPlan {
  const cells: PlannedCell[] = [];
  let position = 0;
  for (const variant of variants) {
    for (const target of targets) {
      cells.push({ variantId: variant.id, target, position });
      position += 1;
    }
  }

  const document: Record<string, unknown> = {
    description: 'rutekit benchmark',
    prompts: variants.map((variant) => ({
      // The label is the variant's id, which is how a result row is traced back.
      label: variant.id,
      // `raw` rather than a template: the variant's prompt is already the
      // concrete text the operator asked for, and running it back through
      // promptfoo's own substitution would re-interpret any `{{…}}` a model was
      // legitimately asked about.
      raw: variant.prompt,
    })),
    providers: targets.map((target) => ({
      id: `file://${options.providerFile}`,
      label: targetKey(target),
      config: {
        baseUrl: options.baseUrl,
        providerId: target.providerId,
        model: target.model,
        systemPrompt: options.systemPrompt,
        thinkingLevel: options.thinkingLevel,
      },
    })),
    // One test case, applied to every prompt: the rubric is a property of the run
    // rather than of a variant, and a per-variant rubric would be a different
    // feature than the one the contract describes.
    tests: [{ assert: options.rubric.map(assertionFor) }],
  };

  return { document, cells };
}
