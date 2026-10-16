import { describe, expect, it } from 'vitest';

import { CHALLENGE_MARKERS, detectChallenge } from '../src/flows/challenge.ts';

/**
 * Noticing that a human is needed (C7c, FR-5.3).
 *
 * The detection is text, so the tests are about which text. The two directions
 * matter differently: a false negative leaves an item waiting until its deadline
 * with no explanation, and a false positive parks an item for an operator who
 * finds nothing to do — so the list is checked for both what it catches and what
 * it deliberately does not.
 */

describe('what counts as a challenge', () => {
  it('catches the English markers a sign-in page uses', () => {
    for (const text of [
      'Please complete the CAPTCHA to continue',
      'Verify your identity',
      'We noticed unusual activity on your account',
      'Enter the code we sent to your phone',
      'Two-factor authentication is required',
      'Security check',
      "I'm not a robot",
    ]) {
      expect(detectChallenge(text).detected, text).toBe(true);
    }
  });

  it('catches the phrasing qoder uses, which the older marker missed', () => {
    // Found by driving qoder's sign-in rather than by reasoning: the page says
    // "we need to be sure you are human", which contains `you are human` and
    // *not* `are you human`. The list had only the latter, so the detector
    // reported no challenge on the one page that was one — and the item would
    // have timed out waiting for a page that was never coming.
    expect(
      detectChallenge('Before continuing, we need to be sure you are human. Click to verify.')
        .detected,
    ).toBe(true);
  });

  it('catches the CJK markers, which is why they are in the list', () => {
    // The curated catalogue includes Chinese providers, and their challenge pages
    // are in Chinese. A detector that only knew English would report "no
    // challenge found" on exactly the pages it most needs to catch (FR-5.3).
    for (const text of [
      '请输入验证码',
      '两步验证',
      '双重验证',
      '验证您的身份',
      '人机验证',
      '安全验证',
    ]) {
      expect(detectChallenge(text).detected, text).toBe(true);
    }
  });

  it('catches the traditional forms too', () => {
    for (const text of ['驗證碼', '兩步驗證', '雙重驗證']) {
      expect(detectChallenge(text).detected, text).toBe(true);
    }
  });

  it('is case-insensitive for the Latin markers', () => {
    expect(detectChallenge('CAPTCHA').detected).toBe(true);
    expect(detectChallenge('captcha').detected).toBe(true);
    expect(detectChallenge('CaPtChA').detected).toBe(true);
  });

  it('names the marker that matched, so the operator knows what to expect', () => {
    // "captcha" and "verify your identity" are different things to walk over to
    // the browser for, and the card says which one it is.
    expect(detectChallenge('please complete the captcha').marker).toBe('captcha');
    expect(detectChallenge('验证您的身份').marker).toBe('验证您的身份');
  });
});

describe('what does not count', () => {
  it('leaves an ordinary sign-in page alone', () => {
    for (const text of [
      'Sign in to your account',
      'Email address',
      'Password',
      'Forgot your password?',
      'Welcome back',
    ]) {
      expect(detectChallenge(text).detected, text).toBe(false);
    }
  });

  it('does not fire on the word "verify" alone', () => {
    // "Verify your email" is a step the flow can take itself, and matching a bare
    // `verify` would park every sign-up form for a human.
    expect(detectChallenge('Verify your email address to continue').detected).toBe(false);
  });

  it('does not fire on a device page that is showing a code', () => {
    // This one was found by a test rather than by reasoning: a device page says
    // "Enter the code WXYZ-1234 to continue" while *displaying* the code, and a
    // marker of `enter the code` parked every device sign-in for an operator who
    // had nothing to solve.
    expect(
      detectChallenge('Device authorization. Enter the code WXYZ-1234 to continue.').detected,
    ).toBe(false);
  });

  it('does not fire on a Chinese page that is merely a sign-in form', () => {
    expect(detectChallenge('登录 邮箱 密码 忘记密码').detected).toBe(false);
  });

  it('reports no marker when nothing matched', () => {
    expect(detectChallenge('Sign in').marker).toBeNull();
  });

  it('handles an empty page', () => {
    expect(detectChallenge('')).toEqual({ detected: false, marker: null });
  });
});

describe('the marker list itself', () => {
  it('carries the CJK markers FR-5.3 names', () => {
    // Named in the requirement, so their absence is a regression rather than a
    // judgement call.
    expect(CHALLENGE_MARKERS).toContain('两步验证');
    expect(CHALLENGE_MARKERS).toContain('双重验证');
    expect(CHALLENGE_MARKERS).toContain('验证您的身份');
  });

  it('carries no marker short enough to match everything', () => {
    // A marker every page carries would park every item, and the floor differs by
    // script: three CJK characters are already a phrase, where three Latin
    // letters are a syllable. `captcha` and its vendor spellings are single
    // English words and are the point of the list, so they are the exception the
    // length rule is written around rather than against.
    const singleWord = new Set(['captcha', 'recaptcha', 'hcaptcha']);

    for (const marker of CHALLENGE_MARKERS) {
      const isCjk = /[㐀-鿿]/u.test(marker);
      const floor = isCjk ? 3 : singleWord.has(marker) ? 7 : 8;
      expect(marker.trim().length, marker).toBeGreaterThanOrEqual(floor);
    }
  });

  it('carries no Latin marker that is a fragment of an ordinary word', () => {
    // The failure this guards is a marker like `verify` or `code`, which every
    // sign-in form contains. Every marker is either a phrase, a hyphenated term
    // no ordinary form uses, or one of the captcha words named explicitly — and
    // the whole list is checked against a page that must not trip it, in the
    // "what does not count" block above.
    const singleWord = new Set(['captcha', 'recaptcha', 'hcaptcha']);

    for (const marker of CHALLENGE_MARKERS) {
      if (/[㐀-鿿]/u.test(marker) || singleWord.has(marker)) continue;
      expect(marker.includes(' ') || marker.includes('-'), marker).toBe(true);
    }
  });
});
