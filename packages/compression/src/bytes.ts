/**
 * Byte and token accounting.
 *
 * Everything the pipeline reports is measured in UTF-8 bytes, because that is a
 * number this package can produce exactly and a token count it cannot — token
 * boundaries are the provider's tokeniser, not ours. A byte count is converted
 * with the same four-bytes-per-token rule the dashboard's fixture uses, so the
 * page and the server agree on what a saving means.
 *
 * Savings are floored. A compression figure that overstates itself is worse than
 * one that understates: the operator makes a keep-or-drop decision from it.
 */

const BYTES_PER_TOKEN = 4;

const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** The serialised size of a request — the unit every stage's effect is measured in. */
export function requestBytes(request: unknown): number {
  return byteLength(JSON.stringify(request));
}

/**
 * A byte count as a token count, by the same rule everything else here uses.
 *
 * Exported because the savings record needs both ends of a turn — how many tokens
 * went in as well as how many came out — and deriving the "in" figure anywhere
 * else would be a second place that has to know the four-bytes-per-token rule.
 * Two places that know it is two places that can disagree, and a savings figure
 * whose own arithmetic disagrees is worse than no figure.
 */
export function bytesToTokens(bytes: number): number {
  return Math.floor(Math.max(0, bytes) / BYTES_PER_TOKEN);
}

/** Tokens removed between two sizes; never negative, never overstated. */
export function tokensSaved(bytesIn: number, bytesOut: number): number {
  if (bytesOut >= bytesIn) return 0;
  return Math.floor((bytesIn - bytesOut) / BYTES_PER_TOKEN);
}
