/**
 * Card numbers that pass the check every endpoint runs (C8, FR-11.2).
 *
 * The Luhn check is the only structural test a card number has to satisfy before
 * anything else happens to it: the last digit is a checksum over the rest, and a
 * number that fails it is rejected by the first validator that looks at it —
 * before the issuer is even contacted. So a generated number that fails Luhn is
 * not a card, it is a string.
 *
 * **The check digit is computed, not appended at random.** Minting the body and
 * then choosing the last digit so the whole number checks out is what makes the
 * generation correct by construction rather than correct by retry.
 *
 * **The grouping is by length, because the lengths differ.** Amex is fifteen
 * digits in a 4-6-5 split; everything else here is sixteen in fours. A 15-digit
 * number shown in fours reads as a different card, and the whole point of the
 * display string is that a person can glance at it and know which card they hold.
 *
 * Pure: digits in, a digit out.
 */

/** Whether a number satisfies the Luhn checksum. */
export function passesLuhn(number: string): boolean {
  if (!/^\d+$/u.test(number)) return false;

  let sum = 0;
  // From the right, every second digit is doubled — the check digit is the
  // rightmost, so the doubling starts with the one before it.
  let double = false;
  for (let index = number.length - 1; index >= 0; index -= 1) {
    const digit = Number(number[index]);
    if (double) {
      const product = digit * 2;
      // A doubled digit above nine has its digits added, which is the same as
      // subtracting nine and is what the algorithm actually specifies.
      sum += product > 9 ? product - 9 : product;
    } else {
      sum += digit;
    }
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * The check digit that makes `body` satisfy Luhn.
 *
 * `body` is everything but the final digit. The result is appended to it to form
 * a valid number — which is why generation computes this rather than retrying a
 * random digit until one passes.
 */
export function checkDigit(body: string): number {
  if (!/^\d+$/u.test(body)) throw new Error('a card body must be digits');

  let sum = 0;
  // The digit about to be appended shifts every existing position by one, so the
  // doubling pattern starts on the body's rightmost digit rather than skipping it.
  let double = true;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const digit = Number(body[index]);
    if (double) {
      const product = digit * 2;
      sum += product > 9 ? product - 9 : product;
    } else {
      sum += digit;
    }
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** A number of `length` digits beginning with `bin`, satisfying Luhn. */
export function completeNumber(bin: string, digits: readonly number[], length: number): string {
  const bodyLength = length - 1;
  const middleLength = bodyLength - bin.length;
  if (middleLength < 0) {
    throw new Error(`a ${String(bin.length)}-digit BIN cannot fit a ${String(length)}-digit number`);
  }

  const middle = digits.slice(0, middleLength).map(String).join('').padEnd(middleLength, '0');
  const body = `${bin}${middle}`;
  return `${body}${String(checkDigit(body))}`;
}

/**
 * The display form: the BIN, the middle replaced with bullets, and the last four.
 *
 * The grouping follows the number's length because it has to. Amex is fifteen
 * digits in a 4-6-5 split; everything else is sixteen in fours.
 */
export function maskedNumber(bin: string, last4: string, length: number): string {
  const masked = `${bin}${'•'.repeat(Math.max(0, length - bin.length - last4.length))}${last4}`;
  const groups = length === 15 ? [4, 6, 5] : [4, 4, 4, 4];

  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    parts.push(masked.slice(at, at + size));
    at += size;
  }
  return parts.join(' ');
}

/**
 * The same number grouped the way a form field expects it typed.
 *
 * A length the grouping does not cover — an unusual issuer range — comes back
 * ungrouped rather than truncated, so the caller always gets every digit.
 */
export function groupedNumber(pan: string): string {
  const groups = pan.length === 15 ? [4, 6, 5] : pan.length === 16 ? [4, 4, 4, 4] : null;
  if (groups === null) return pan;

  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    parts.push(pan.slice(at, at + size));
    at += size;
  }
  return parts.join(' ');
}
