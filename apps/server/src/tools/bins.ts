import type { VccBin, VccBrand } from '@contracts';

/**
 * The issuer ranges the generator can be pointed at (C8, FR-11.2).
 *
 * A BIN is not a free-form number an operator types: the range a card is minted
 * under decides its brand, its length, whether it is accepted at all, and how the
 * issuer's own risk checks treat it. Offering the ranges as a catalogue — each
 * carrying the facts that decide those things — is what makes the choice a choice
 * rather than a guess.
 *
 * **A curated list, not a table.** It changes when rutekit is upgraded, not when
 * an operator edits something, and a table would buy a migration and a repository
 * for a list nothing ever writes to.
 *
 * **These are test ranges.** The numbers are the publicly documented ones the
 * card networks publish for their own testing — `4111 11…`, `5555 55…`,
 * `3782 82…` — plus a handful of real issuer ranges whose leading digits are
 * public. They are here so a generated card is structurally correct; whether any
 * endpoint accepts it is the endpoint's business, which is what `acceptance`
 * describes.
 */
const BINS: readonly VccBin[] = [
  {
    bin: '411111',
    brand: 'visa',
    issuer: 'Test Card',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.99,
  },
  {
    bin: '424242',
    brand: 'visa',
    issuer: 'Test Card',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.97,
  },
  {
    bin: '400005',
    brand: 'visa',
    issuer: 'Test Card',
    country: 'United States',
    countryCode: 'US',
    type: 'debit',
    currency: 'USD',
    length: 16,
    acceptance: 0.62,
  },
  {
    bin: '426398',
    brand: 'visa',
    issuer: 'JPMorgan Chase',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.88,
  },
  {
    bin: '453201',
    brand: 'visa',
    issuer: 'Wells Fargo',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.81,
  },
  {
    bin: '555555',
    brand: 'mastercard',
    issuer: 'Test Card',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.98,
  },
  {
    bin: '510510',
    brand: 'mastercard',
    issuer: 'Test Card',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.95,
  },
  {
    bin: '222300',
    brand: 'mastercard',
    issuer: 'Test Card (2-series)',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.71,
  },
  {
    bin: '541333',
    brand: 'mastercard',
    issuer: 'Citibank',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.84,
  },
  {
    bin: '532150',
    brand: 'mastercard',
    issuer: 'HSBC',
    country: 'United Kingdom',
    countryCode: 'GB',
    type: 'debit',
    currency: 'GBP',
    length: 16,
    acceptance: 0.57,
  },
  {
    bin: '378282',
    brand: 'amex',
    issuer: 'Test Card',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 15,
    acceptance: 0.93,
  },
  {
    bin: '371449',
    brand: 'amex',
    issuer: 'Test Card',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 15,
    acceptance: 0.9,
  },
  {
    bin: '601111',
    brand: 'discover',
    issuer: 'Test Card',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.89,
  },
  {
    bin: '601100',
    brand: 'discover',
    issuer: 'Test Card',
    country: 'United States',
    countryCode: 'US',
    type: 'credit',
    currency: 'USD',
    length: 16,
    acceptance: 0.66,
  },
];

export function vccBins(): readonly VccBin[] {
  return BINS;
}

/**
 * The range a batch should be minted under.
 *
 * When the operator named one, it is that one — and the caller checks it belongs
 * to the brand they asked for, because a batch claiming a Visa brand under an
 * Amex range is a contradiction the request should not be able to express.
 *
 * When they named none, it is the best-accepted range for the brand. That is the
 * reading of "pick for me" that a pool exists for: the operator wants a card that
 * works, and `acceptance` is the only evidence rutekit has about which one does.
 */
export function chooseBin(brand: VccBrand, bin: string | null): VccBin | null {
  const forBrand = BINS.filter((entry) => entry.brand === brand);
  if (forBrand.length === 0) return null;
  if (bin === null) {
    return forBrand.reduce((best, entry) => (entry.acceptance > best.acceptance ? entry : best));
  }
  return forBrand.find((entry) => entry.bin === bin) ?? null;
}
