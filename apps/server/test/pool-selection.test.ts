import { describe, expect, it } from 'vitest';

import { selectAccount, type Candidate } from '@server/pool/selection.ts';

/**
 * Which account a turn is sent as (FR-3.2).
 *
 * Pure — candidates in, a choice and a cursor out — so the whole strategy is
 * asserted here without a database or a clock. The cases that matter are the two
 * the strategies disagree about: whether an operator's stated order is kept, and
 * whether a busy account is skipped in favour of an idle sibling.
 */

function candidate(id: string, inFlight = 0, maxInFlight = 1): Candidate {
  return { id, inFlight, maxInFlight };
}

describe('selectAccount', () => {
  it('answers null when there is nothing to choose from', () => {
    expect(selectAccount([], 'round_robin', 0)).toBeNull();
  });

  it('answers null when every account is at its ceiling', () => {
    const busy = [candidate('a', 1, 1), candidate('b', 2, 2)];
    expect(selectAccount(busy, 'round_robin', 0)).toBeNull();
    expect(selectAccount(busy, 'sequential', 0)).toBeNull();
  });

  describe('sequential', () => {
    it('keeps the operator’s order and does not rotate', () => {
      const accounts = [candidate('a'), candidate('b'), candidate('c')];

      expect(selectAccount(accounts, 'sequential', 0)?.accountId).toBe('a');
      // The cursor is handed back untouched, so the next call makes the same
      // choice: `sequential` has no rotation to resume.
      expect(selectAccount(accounts, 'sequential', 5)).toEqual({ accountId: 'a', cursor: 5 });
    });

    it('skips an account that is at its ceiling', () => {
      const accounts = [candidate('a', 1, 1), candidate('b', 0, 1)];
      expect(selectAccount(accounts, 'sequential', 0)?.accountId).toBe('b');
    });
  });

  describe('round_robin', () => {
    it('rotates through the idle accounts and advances the cursor', () => {
      const accounts = [candidate('a'), candidate('b'), candidate('c')];

      expect(selectAccount(accounts, 'round_robin', 0)).toEqual({ accountId: 'a', cursor: 1 });
      expect(selectAccount(accounts, 'round_robin', 1)).toEqual({ accountId: 'b', cursor: 2 });
      expect(selectAccount(accounts, 'round_robin', 2)).toEqual({ accountId: 'c', cursor: 3 });
      // The fourth call wraps rather than running off the end.
      expect(selectAccount(accounts, 'round_robin', 3)).toEqual({ accountId: 'a', cursor: 4 });
    });

    it('prefers the account carrying the fewest turns', () => {
      const accounts = [candidate('a', 1, 2), candidate('b', 0, 2)];
      expect(selectAccount(accounts, 'round_robin', 0)?.accountId).toBe('b');
    });

    it('breaks a tie by the rotation, so two idle accounts alternate', () => {
      const accounts = [candidate('a', 0, 1), candidate('b', 0, 1)];

      const first = selectAccount(accounts, 'round_robin', 0);
      const second = selectAccount(accounts, 'round_robin', first?.cursor ?? 0);
      expect(first?.accountId).toBe('a');
      expect(second?.accountId).toBe('b');
    });

    it('only ever rotates through the free accounts', () => {
      // `a` is full, so it is not in the rotation at all — the cursor indexes
      // the free set, not the whole list.
      const accounts = [candidate('a', 1, 1), candidate('b', 0, 1), candidate('c', 0, 1)];
      expect(selectAccount(accounts, 'round_robin', 0)?.accountId).toBe('b');
      expect(selectAccount(accounts, 'round_robin', 1)?.accountId).toBe('c');
      expect(selectAccount(accounts, 'round_robin', 2)?.accountId).toBe('b');
    });

    it('still indexes when the cursor is negative', () => {
      const accounts = [candidate('a'), candidate('b')];
      expect(selectAccount(accounts, 'round_robin', -1)?.accountId).toBe('b');
    });
  });
});
