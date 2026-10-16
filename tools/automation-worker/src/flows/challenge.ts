/**
 * Noticing that a human is needed (C7c, FR-5.3).
 *
 * A provider's sign-in sometimes stops and asks for something only a person can
 * give: a captcha, a one-time code, a "verify it's you" challenge. Nothing in the
 * page says so in a way a program can read reliably — the challenge is an image,
 * or a widget in an iframe — so the detection is **text**: the page's own words.
 *
 * That is a weak signal, and it is the right one anyway. A challenge page is
 * *about* the challenge, so it says "captcha", "verify", "unusual activity"; the
 * alternative is an image classifier, which is a much larger thing to ship and to
 * keep working. The cost of the weakness is bounded in both directions: a false
 * positive parks an item for a human who finds nothing to do and answers
 * anything, and a false negative means the item times out — neither loses the
 * batch.
 *
 * **The CJK markers are not decoration.** The providers rutekit curates include
 * Chinese ones, and their challenge pages are in Chinese: `两步验证` (two-step
 * verification), `双重验证` (two-factor), `验证您的身份` (verify your identity). A
 * detector that only knew English would report "no challenge found" on exactly
 * the pages it most needs to catch, and the item would sit until its deadline
 * with no explanation.
 *
 * Pure: page text in, a verdict out.
 */

/**
 * Phrases that mean a human is needed, in the languages the curated providers
 * actually sign in through.
 *
 * Lower-cased for the Latin ones because a page may shout; the CJK ones have no
 * case and are matched as written.
 *
 * **Every entry has to be specific to a challenge**, and the ones that are not
 * were removed after they misfired: a bare `verify` matches "verify your email"
 * on an ordinary sign-up form, and `enter the code` matched a device page that
 * was legitimately *showing* a code rather than asking for one. A false positive
 * parks an item for an operator who finds nothing to do, so the cost of a vague
 * marker is a batch that stalls for no reason.
 */
const MARKERS: readonly string[] = [
  // English
  'captcha',
  'recaptcha',
  'hcaptcha',
  'i am not a robot',
  "i'm not a robot",
  'unusual activity',
  'suspicious activity',
  'verify your identity',
  'two-factor',
  'two factor',
  '2-step verification',
  'two-step verification',
  'enter the verification code',
  'enter the code we sent',
  'enter the 6-digit code',
  'security check',
  'are you human',
  // The phrasing qoder uses, and the reason it is a separate entry from the one
  // above: "we need to be sure you are human" contains `you are human` and not
  // `are you human`, so the older marker matched everything except the page that
  // needed it. Found by driving qoder's sign-in rather than by reasoning.
  'you are human',
  // Simplified Chinese
  '验证码',
  '两步验证',
  '双重验证',
  '验证您的身份',
  '人机验证',
  '安全验证',
  '请输入验证码',
  // Traditional Chinese
  '驗證碼',
  '兩步驗證',
  '雙重驗證',
  '驗證您的身分',
];

export interface ChallengeVerdict {
  /** True when the page is asking for something only a person can give. */
  readonly detected: boolean;
  /** The marker that matched, for the step detail. Null when nothing did. */
  readonly marker: string | null;
}

const NOT_DETECTED: ChallengeVerdict = { detected: false, marker: null };

/**
 * Whether this page text is a challenge.
 *
 * A `marker` is returned rather than a bare boolean because the operator's card
 * says *why* the item is parked — "captcha" and "verify your identity" are
 * different things to walk over to the browser for.
 */
export function detectChallenge(text: string): ChallengeVerdict {
  const haystack = text.toLowerCase();
  for (const marker of MARKERS) {
    // A CJK marker has no case, so the lowered haystack still contains it.
    if (haystack.includes(marker)) return { detected: true, marker };
  }
  return NOT_DETECTED;
}

/** Every marker, for a test that wants to prove the list is what it claims. */
export const CHALLENGE_MARKERS: readonly string[] = MARKERS;
