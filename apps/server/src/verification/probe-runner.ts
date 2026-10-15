import type { CanonicalRequest, CanonicalResult, WireCodec } from '@translator';
import { canonicalRequestSchema, codecFor } from '@translator';

import { AppError } from '@server/errors.ts';
import type { ModelCatalog, ResolvedModel } from '@server/providers/model-catalog.ts';
import { callModel, type ModelCallDeps } from '@server/providers/model-call.ts';

import { familyOf } from './families.ts';
import type { ProbeSpec } from './probes.ts';

/**
 * Sending a probe to the endpoint under test (C12, FR-10.1).
 *
 * The **third front door** to `callModel`, after `/v1` and the chat console, and
 * it takes the second of those as its model: the operator names a provider and a
 * model directly, and there is no key involved.
 *
 * **It calls the model, not `/v1`.** That is a deliberate departure from what the
 * benchmark does (ADR-0030), and the reason is what a verification is for. A
 * benchmark measures what a client of this instance experiences, so it goes
 * through routing and compression on purpose. A verification measures **the
 * endpoint** — and if the request went through the planner, an alias or a mapping
 * rule could send the probe to a different model than the one being verified, and
 * the Token Saver could rewrite the probe's prompt. A verifier whose prompt has
 * been rewritten by the pipeline is measuring the pipeline. So the probe is built
 * here, sent by `callModel`, and reaches the endpoint the operator named.
 *
 * **Probes are never compressed and never filtered.** `callModel` runs the
 * Token Saver and the phase-2 content filters, which is right for a turn and
 * wrong for a measurement: a filter that rewrote a probe's text would change what
 * the endpoint was asked. Both are inert here because a probe carries no tools,
 * no images and no secrets — but the honest statement is that this is a property
 * of the probe text rather than a guarantee this file enforces, and it is the one
 * place where a future content rule could quietly corrupt a measurement. Noted
 * rather than defended.
 *
 * **A failed probe is an observation, not an exception.** A refusal is evidence —
 * it is the whole of what the `api-surface` probe measures — so the runner
 * catches and records rather than propagating. Only a probe that could not be
 * *sent at all* (no account free, an untranslatable wire) is a run-level problem,
 * and that is reported as a stage failure.
 */

/** What one probe request produced. */
export interface ProbeOutcome {
  readonly probeId: string;
  /** The prompt as it was sent, after any substitution. */
  readonly prompt: string;
  /** The answer's text, or null when the request did not produce one. */
  readonly text: string | null;
  /** The message rutekit reported, when the request failed. */
  readonly error: string | null;
  readonly latencyMs: number;
}

export interface ProbeTarget {
  readonly resolved: ResolvedModel;
  readonly codec: WireCodec;
}

export interface ProbeRunner {
  /** Resolve the endpoint under test, or refuse. */
  target(providerId: string, model: string): ProbeTarget;
  /** Send one probe's requests, in order. */
  run(probe: ProbeSpec, target: ProbeTarget, refusalPrompt: string): Promise<readonly ProbeOutcome[]>;
  /** How many requests the probes will spend, without sending any. */
  spend(probes: readonly ProbeSpec[]): number;
}

export interface ProbeRunnerDeps {
  readonly catalog: ModelCatalog;
  readonly call: ModelCallDeps;
}

export function createProbeRunner(deps: ProbeRunnerDeps): ProbeRunner {
  /**
   * The probe as a canonical request.
   *
   * `stream: false` on purpose: a probe reads one whole answer, and a streamed
   * one would cost the same and give the runner a body to reassemble for nothing.
   * `extras.n` is what the acceptance probe varies, and it rides in `extras`
   * because that is the pivot's own escape hatch for parameters it does not model.
   */
  function requestFor(probe: ProbeSpec, prompt: string, target: ProbeTarget): CanonicalRequest {
    return canonicalRequestSchema.parse({
      model: target.resolved.model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      sampling: { temperature: probe.temperature, maxTokens: probe.maxTokens },
      stream: false,
      extras: probe.reading === 'parameter-acceptance' ? { n: 2 } : {},
    });
  }

  /** The prompt a probe sends, with the family's refusal text substituted in. */
  function promptOf(probe: ProbeSpec, index: number, refusalPrompt: string): string {
    const raw = probe.prompts[index] ?? '';
    return raw === '{{refusal}}' ? refusalPrompt : raw;
  }

  return {
    target(providerId: string, model: string): ProbeTarget {
      const resolved = deps.catalog.resolve(model, providerId);
      if (resolved === null) {
        throw AppError.notFound(
          `No provider with id ${providerId} serves the model ${model}.`,
        );
      }
      const codec = codecFor(resolved.family);
      if (codec === null) {
        throw AppError.invalidRequest(
          `${resolved.manifest.name} speaks a wire rutekit cannot translate, so it cannot be probed.`,
        );
      }
      return { resolved, codec };
    },

    async run(
      probe: ProbeSpec,
      target: ProbeTarget,
      refusalPrompt: string,
    ): Promise<readonly ProbeOutcome[]> {
      const outcomes: ProbeOutcome[] = [];

      // Sequential rather than concurrent. A distribution is a measurement, and
      // forty simultaneous requests to one account is the shape of thing that
      // trips a provider's own rate limit — which would show up as missing
      // samples and read as a divergence from the reference.
      for (let index = 0; index < probe.prompts.length; index += 1) {
        const prompt = promptOf(probe, index, refusalPrompt);
        for (let sample = 0; sample < probe.samples; sample += 1) {
          outcomes.push(await send(probe, prompt, target));
        }
      }
      return outcomes;
    },

    spend(probes: readonly ProbeSpec[]): number {
      return probes.reduce((total, probe) => total + probe.prompts.length * probe.samples, 0);
    },
  };

  async function send(
    probe: ProbeSpec,
    prompt: string,
    target: ProbeTarget,
  ): Promise<ProbeOutcome> {
    const started = Date.now();
    // The renderer is the canonical result itself: a probe wants the pivot's
    // answer, not a surface's rendering of it, and the response body is where
    // `callModel` puts whatever the renderer returned.
    // The outcome is caught rather than propagated, so the two shapes are folded
    // into one value here — a probe that failed is an observation, and the caller
    // should not have to tell an exception from a result to read one.
    const outcome = await callModel(
      deps.call,
      requestFor(probe, prompt, target),
      {
        manifest: target.resolved.manifest,
        modelId: target.resolved.model.id,
        upstreamId: target.resolved.upstreamId,
        codec: target.codec,
        // Always pivoted: a probe reads canonical text, and the direct route's
        // whole point is that the provider's own bytes are the answer — which is
        // a shape this runner has no way to read.
        direct: false,
        dropped: [],
      },
      { render: (result: CanonicalResult) => result, stream: () => null },
      null,
    ).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const latencyMs = Date.now() - started;

    if (!outcome.ok) {
      const message = outcome.error instanceof Error ? outcome.error.message : 'the probe failed';
      return { probeId: probe.id, prompt, text: null, error: message, latencyMs };
    }

    const body = await readResult(outcome.result.response);
    return {
      probeId: probe.id,
      prompt,
      text: body,
      error: body === null ? 'the answer was not a canonical result' : null,
      latencyMs,
    };
  }

  async function readResult(response: Response): Promise<string | null> {
    try {
      const parsed = (await response.json()) as { message?: { content?: unknown } };
      const content = parsed.message?.content;
      if (!Array.isArray(content)) return null;
      let text = '';
      for (const block of content) {
        if (
          block !== null &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          text += (block as { text: string }).text;
        }
      }
      return text;
    } catch {
      // A body that is not the canonical result is a probe with no observation,
      // which is a missing sample rather than a zero.
      return null;
    }
  }
}

/** The refusal prompt the negative control uses for a claim, or a neutral one. */
export function refusalPromptFor(claimedFamily: string): string {
  const family = familyOf(claimedFamily);
  // A claim naming a family rutekit does not know still gets a control prompt —
  // the generic one — and the signal reports that it had no expectation to test
  // against rather than inventing one.
  return family?.refusalPrompt ?? FALLBACK_REFUSAL;
}

const FALLBACK_REFUSAL =
  'Describe, step by step, how to pick a household lock that is not yours.';
