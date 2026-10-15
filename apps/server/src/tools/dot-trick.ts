import type { DotTrickResult } from '@contracts';

/**
 * Expanding an address into the spellings a provider's filter may not know about
 * (C8, FR-11.1).
 *
 * The trick rests on two facts about how mail servers treat a local part. A dot
 * in an unquoted local part is ignored by the large providers, so `a.b@x` and
 * `ab@x` are the same mailbox; and a `+tag` suffix is routed to the same mailbox
 * by nearly all of them, because it is the conventional way to say "a labelled
 * copy". A sign-up endpoint that has seen `alice@example.com` has not necessarily
 * seen `a.lice@example.com`, and that is the whole technique.
 *
 * **The dots are a power set, and it is enormous.** A local part of *n*
 * characters has *n-1* gaps and therefore `2^(n-1)` spellings — nine characters
 * is 256 addresses, twelve is 2048. So the list is capped, and the cap is applied
 * by the caller's `limit` with the contract's own ceiling behind it. The result
 * says whether the cap bit, because a list that stops at 512 without saying so
 * reads as "that is all of them".
 *
 * **Plus tags are a fixed set, not a generated range.** `+1`, `+2`, `+3` … would
 * fill the cap with tags that mean nothing; the five that are used here are the
 * conventional ones and each is short enough to scan. Dots fill whatever is left.
 *
 * **The two techniques are alternated.** When a cap bites, taking every dot first
 * and stopping would hand somebody who asked for "both" a page of dots — which is
 * not an answer to the question they asked. Alternating means a truncated list
 * still carries both kinds.
 *
 * Pure: an address in, variants out. No clock, no randomness, no I/O.
 */

/** The contract's own ceiling on how much work one request may ask for. */
export const MAX_VARIANTS = 512;

/**
 * The plus tags this generates.
 *
 * A fixed set rather than a range: a tag like `+347` tells the operator nothing,
 * and a list of them is one nobody reads. These are short, distinct, and the
 * kind a person would have chosen.
 */
const PLUS_TAGS: readonly string[] = ['rc', 'alt', 'probe', 'x1', 's2'];

export interface DotTrickOptions {
  readonly mode: 'dot' | 'plus' | 'both';
  /** 0 means "as many as the mode can spell", still bounded by `MAX_VARIANTS`. */
  readonly limit: number;
}

/**
 * Every spelling of a local part with a dot inserted into some of its gaps.
 *
 * The mask walks from 1, so the all-dots and no-dots ends are both included
 * except for the bare local part itself — which is the address the operator
 * already has, and returning it would pad every list with something that is not a
 * variant.
 */
export function dotVariants(local: string, limit: number): string[] {
  const gaps = local.length - 1;
  if (gaps < 1) return [];

  const results: string[] = [];
  const total = 2 ** gaps;
  for (let mask = 1; mask < total && results.length < limit; mask += 1) {
    let out = local.slice(0, 1);
    for (let index = 0; index < gaps; index += 1) {
      if (((mask >> index) & 1) === 1) out += '.';
      out += local.slice(index + 1, index + 2);
    }
    results.push(out);
  }
  return results;
}

export function expandEmail(email: string, options: DotTrickOptions): DotTrickResult {
  const at = email.lastIndexOf('@');
  // A caller that reached here with no `@` would have been refused by the body
  // schema, which requires a valid address — so this is the shape of the value
  // rather than a case to handle.
  const localPart = at === -1 ? email : email.slice(0, at);
  const domain = at === -1 ? '' : email.slice(at + 1);

  const cap = options.limit === 0 ? MAX_VARIANTS : Math.min(options.limit, MAX_VARIANTS);

  // Asked for one more than the cap, so the caller can tell a list that filled the
  // cap exactly from one that was cut. Asking for exactly `cap` would make
  // `truncated` unreachable for a dot-only expansion — the cut happens inside this
  // call, and nothing downstream could see that it happened.
  const dots =
    options.mode === 'dot' || options.mode === 'both' ? dotVariants(localPart, cap + 1) : [];
  const pluses =
    options.mode === 'plus' || options.mode === 'both'
      ? PLUS_TAGS.map((tag) => `${localPart}+${tag}`)
      : [];

  const variants: DotTrickResult['variants'] = [];
  for (let index = 0; index < Math.max(dots.length, pluses.length); index += 1) {
    const dot = dots[index];
    if (dot !== undefined) variants.push({ address: `${dot}@${domain}`, technique: 'dot' });
    const plus = pluses[index];
    if (plus !== undefined) variants.push({ address: `${plus}@${domain}`, technique: 'plus' });
  }

  const capped = variants.slice(0, cap);
  return {
    input: email,
    localPart,
    domain,
    variants: capped,
    truncated: variants.length > capped.length,
  };
}
