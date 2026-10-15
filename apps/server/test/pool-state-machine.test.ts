import { describe, expect, it } from 'vitest';
import { accountStateSchema } from '@contracts';
import type { AccountState } from '@contracts';

import {
  canTransition,
  isAutomatic,
  isResting,
  isRoutable,
  parseAccountState,
} from '@server/pool/state-machine.ts';

/**
 * The state machine (FR-3.1, ADR-0020).
 *
 * Pure, so these are the cheapest tests in the pool and the ones that carry the
 * most weight: the table in `state-machine.ts` is the whole statement of what an
 * account may do, and every other file in `pool/` only decides *when* to ask it.
 *
 * The distinction under test throughout is "may" against "may, automatically".
 * A move that is legal but not automatic is one only an operator can make, and
 * the two terminal-ish rows — `banned` and `disabled` — are the whole reason the
 * distinction exists.
 */

const STATES = accountStateSchema.options;

describe('canTransition', () => {
  it('never lets a state move to itself', () => {
    for (const state of STATES) {
      expect(canTransition(state, state), state).toBe(false);
    }
  });

  it('lets any live state be taken out by hand', () => {
    for (const state of STATES) {
      if (state === 'disabled') continue;
      expect(canTransition(state, 'disabled'), state).toBe(true);
    }
  });

  it('lets a banned or disabled account be brought back by hand', () => {
    expect(canTransition('banned', 'active')).toBe(true);
    expect(canTransition('disabled', 'active')).toBe(true);
  });

  it('refuses a move the table does not list', () => {
    // `pending` is a fresh credential that has never been used, so there is
    // nothing that could have rate-limited or exhausted it.
    expect(canTransition('pending', 'rate_limited')).toBe(false);
    expect(canTransition('pending', 'exhausted')).toBe(false);
    // An operator may also mark a disabled account as banned, but never the
    // reverse pair the table leaves out.
    expect(canTransition('disabled', 'banned')).toBe(true);
    expect(canTransition('banned', 'rate_limited')).toBe(false);
  });
});

describe('isAutomatic', () => {
  it('is false for every move into disabled', () => {
    for (const state of STATES) {
      if (state === 'disabled') continue;
      expect(isAutomatic(state, 'disabled'), state).toBe(false);
    }
  });

  it('is false for every move out of banned or disabled', () => {
    expect(isAutomatic('banned', 'active')).toBe(false);
    expect(isAutomatic('banned', 'disabled')).toBe(false);
    expect(isAutomatic('disabled', 'active')).toBe(false);
    expect(isAutomatic('disabled', 'banned')).toBe(false);
  });

  it('is true for the moves the pool observes on its own', () => {
    expect(isAutomatic('pending', 'active')).toBe(true);
    expect(isAutomatic('active', 'rate_limited')).toBe(true);
    expect(isAutomatic('rate_limited', 'active')).toBe(true);
    expect(isAutomatic('exhausted', 'active')).toBe(true);
    expect(isAutomatic('error', 'active')).toBe(true);
    // A provider telling rutekit a credential is dead is the one signal that
    // arrives without a human, which is why this one is here.
    expect(isAutomatic('active', 'banned')).toBe(true);
  });

  it('never calls a move automatic that is not even legal', () => {
    for (const from of STATES) {
      for (const to of STATES) {
        if (isAutomatic(from, to)) expect(canTransition(from, to), `${from}->${to}`).toBe(true);
      }
    }
  });
});

describe('parseAccountState', () => {
  it('narrows every state the contract names', () => {
    for (const state of STATES) {
      expect(parseAccountState(state)).toBe(state);
    }
  });

  it('answers null for text that is not a state', () => {
    expect(parseAccountState('actve')).toBeNull();
    expect(parseAccountState('')).toBeNull();
    expect(parseAccountState('ACTIVE')).toBeNull();
  });
});

describe('isRoutable', () => {
  it('routes only an active account', () => {
    for (const state of STATES) {
      expect(isRoutable(state), state).toBe(state === 'active');
    }
  });
});

describe('isResting', () => {
  it('rests only while a clock is what is holding the account back', () => {
    const resting = STATES.filter((state: AccountState) => isResting(state));
    // Sorted, so the assertion is about membership rather than the contract's
    // own listing order.
    expect([...resting].sort()).toEqual(['exhausted', 'rate_limited']);
  });
});
