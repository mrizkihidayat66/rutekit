import type { ErrorClass, ErrorRule, ErrorScope } from './manifest/errors.ts';
import type { ProviderManifest } from './manifest.ts';

/**
 * Turning a failed call into the class of failure it was.
 *
 * The rules live in the manifest because the meaning of a status is the
 * provider's, not rutekit's: the same 429 is a rate limit at one upstream and a
 * spent balance at another, and only the provider's own body text tells them
 * apart. This is the code that reads those rules.
 *
 * A rule's two halves are independent, which is what lets a provider be described
 * by either: `statuses` catches the one that answers 429, `matches` catches the
 * one that answers 200 with an error object in the body, and a rule that names
 * both needs both. First match wins, so the manifest's order is load-bearing —
 * the specific rule before the general one.
 */

/** What a failed call looks like from outside: a status and a body. */
export interface FailureSignal {
  readonly status: number;
  /** The response body as text; empty when it could not be read at all. */
  readonly body: string;
}

/** The rule that claimed a failure, and what it says the failure means. */
export interface Failure {
  readonly class: ErrorClass;
  readonly scope: ErrorScope;
  /** The rule itself, so a caller can log which one fired. */
  readonly rule: ErrorRule;
}

/**
 * The rule that claims this signal, or null when no rule does.
 *
 * Null is a real answer: a provider whose rules do not cover a status has told
 * rutekit nothing about it, and inventing a class would be worse than admitting
 * the manifest is incomplete.
 */
export function classifyFailure(manifest: ProviderManifest, signal: FailureSignal): Failure | null {
  const body = signal.body.toLowerCase();

  for (const rule of manifest.errors) {
    const statusMatches = rule.statuses.length === 0 || rule.statuses.includes(signal.status);
    if (!statusMatches) continue;

    const bodyMatches =
      rule.matches.length === 0 ||
      rule.matches.some((needle) => body.includes(needle.toLowerCase()));
    if (!bodyMatches) continue;

    return { class: rule.class, scope: rule.scope, rule };
  }

  return null;
}
