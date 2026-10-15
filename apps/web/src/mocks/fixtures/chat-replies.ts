import type { FinishReason } from '@contracts';

/**
 * Canned answers for a live chat turn.
 *
 * The stored sessions in `fixtures/tools.ts` are hand-authored because each one
 * exists to exercise a different rendering path. A *live* turn has the opposite
 * problem: the operator types anything at all, so the mock has to answer
 * plausibly without knowing what was asked. It does that by reading the question
 * for a topic and picking the answer that puts the matching renderer on screen —
 * a fenced block, a display equation, a diagram — so every part of the
 * transcript is reachable from the composer rather than only from the fixtures.
 *
 * The prose is about rutekit on purpose. An answer about a fictional router is
 * the only kind of answer that stays useful while the backend is still a plan.
 */

export interface ChatReplyPlan {
  /** Deliberation, streamed before the answer. Null when the turn is not thinking. */
  readonly reasoning: string | null;
  readonly text: string;
  /** A tool the assistant reaches for instead of guessing. */
  readonly toolCall: {
    readonly name: string;
    readonly input: Record<string, unknown>;
  } | null;
  readonly finishReason: FinishReason;
}

const TOPICS: readonly { readonly match: RegExp; readonly reply: Omit<ChatReplyPlan, 'reasoning'> }[] = [
  {
    // A diagram, so the mermaid renderer has something to draw.
    match: /diagram|flow|mermaid|pipeline|architecture|topolog|graph/i,
    reply: {
      text: `The request path has four stages, and the pool sits between translation and routing:

\`\`\`mermaid
flowchart LR
  A[Client] --> B[Translate to pivot]
  B --> C{Key valid?}
  C -- no --> D[401 authentication]
  C -- yes --> E[Compress]
  E --> F[Lease an account]
  F --> G[Provider]
  G --> H[Translate back]
\`\`\`

Each arrow is a place the request can fail without the client seeing a provider-shaped error, which is why the error surface is one shape for all of them.`,
      toolCall: null,
      finishReason: 'stop',
    },
  },
  {
    // An equation, so the math renderer has something to typeset.
    match: /math|formula|katex|probabilit|equation|expected|variance|statistic/i,
    reply: {
      text: `Treat the pool as a set of independent accounts. If one account is rate-limited with probability $p$ on any given request, the chance that all $n$ of them are limited at once — and the request therefore fails — is

$$P_{\\text{fail}} = p^{n}$$

which is why the interesting quantity is not the *number* of accounts but the number of accounts that are healthy at the same instant:

$$n_{\\text{eff}} = n \\cdot (1 - u)$$

where $u$ is the fraction parked in cooldown. Doubling $n$ halves nothing; it squares the failure term.`,
      toolCall: null,
      finishReason: 'stop',
    },
  },
  {
    // A tool call, so the tool chip and the unmatched-call path both render.
    match: /account|pool|lease|credential|which key|rotate/i,
    reply: {
      text: `I would read the lease implementation before answering that, because the failure mode you are describing is a check-then-act race rather than a capacity problem.`,
      toolCall: {
        name: 'read_file',
        input: { path: 'packages/core/src/pool/lease.ts' },
      },
      finishReason: 'tool_calls',
    },
  },
  {
    // Code, so the highlighter has something to colour.
    match: /code|bug|race|function|typescript|javascript|sql|regex|script|implement/i,
    reply: {
      text: `The fix is to make the selection and the reservation one operation. Right now they are two, so two concurrent requests can both observe the same free account:

\`\`\`ts
// Before: two round trips, and the gap between them is the bug.
const account = pool.find((entry) => entry.isFree());
account.reserve();

// After: the pool hands out the account it just took.
const account = pool.reserveNext();
if (account === null) throw new PoolExhaustedError();
\`\`\`

The second form is the same amount of code and cannot lose a race, because there is no interval in which the account is free but unclaimed.`,
      toolCall: null,
      finishReason: 'stop',
    },
  },
  {
    // An image, so the attachment path renders on the answer side too.
    match: /image|picture|screenshot|chart|photo|attached/i,
    reply: {
      text: `I can see the attachment. The shape is a long flat run followed by a steep climb, and the knee is sharp rather than gradual — that is characteristic of a fixed capacity being exceeded, not of load growing smoothly. If the flat section is your normal traffic, the climb starts when the healthy pool shrinks below what the arrival rate needs.`,
      toolCall: null,
      finishReason: 'stop',
    },
  },
];

const FALLBACK: Omit<ChatReplyPlan, 'reasoning'> = {
  text: `Short answer: it depends on which layer is asking.

- **The router** cares about *which endpoint* can serve the request, so it reasons about capability and quota.
- **The pool** cares about *which credential* is free right now, so it reasons about leases and cooldown.
- **The console** cares about neither; it reads what the other two decided and shows it.

Keeping those three apart is what stops a quota decision from turning into a routing decision by accident. If you tell me which layer you mean, I can be specific about it.`,
  toolCall: null,
  finishReason: 'stop',
};

/** Reasoning is only written when the session asked the model to think. */
const REASONING: Readonly<Record<string, string>> = {
  medium: 'This looks like a question about one specific layer rather than the whole system, so I should answer narrowly and offer to go wider at the end. The obvious reading is the one I will take.',
  high: 'Two readings are possible here: a question about behaviour, and a question about implementation. The wording points at behaviour, so I will answer that first and leave the implementation as a follow-up rather than padding the answer with both.',
  xhigh: 'I want to check the framing before answering. The question assumes the three layers are separable, which they are — but only if the pool never makes a routing decision, and that is exactly the invariant the current design protects. So the answer should name that invariant rather than just listing the layers.',
  max: 'There are three plausible readings and I cannot tell from the wording alone which one is meant, so the honest answer names the distinction and asks. Guessing would produce a long answer that is right for a question nobody asked, which is worse than a short one that is right for the question actually asked.',
};

/**
 * Pick the answer for a live turn.
 *
 * The image case wins over the keyword cases: an attachment is unambiguous
 * evidence about what the operator is asking, and a prompt that mentions "chart"
 * while carrying a picture is asking about the picture.
 */
export function planChatReply(input: {
  readonly prompt: string;
  readonly hasImage: boolean;
  readonly thinkingLevel: string;
}): ChatReplyPlan {
  const reasoning = REASONING[input.thinkingLevel] ?? null;
  const chosen = input.hasImage
    ? TOPICS.find((topic) => topic.match.test('image'))
    : TOPICS.find((topic) => topic.match.test(input.prompt));
  return { ...(chosen?.reply ?? FALLBACK), reasoning };
}
