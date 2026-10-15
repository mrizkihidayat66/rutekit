import { z } from 'zod';
import { isoDateTimeSchema } from '../common.ts';

/**
 * Virtual-card pool (FR-12.x). Cards are generated in batches and drawn down as
 * provider sign-ups need one, which is why the pool tracks what a card is doing
 * rather than who owns it.
 *
 * The lifecycle is the one the roadmap names — `active` / `reserved` / `used` /
 * `declined` — and it is a one-way street in practice: a card is minted `active`,
 * held `reserved` while a sign-up is mid-flight, and ends either `used` when that
 * sign-up succeeds or `declined` when the issuer refuses it. Only a `reserved`
 * card can go back to `active`; a `declined` one is finished.
 *
 * The full PAN is never on a read model. `maskedNumber` is what the UI shows and
 * `last4` is the searchable key; the secret half lives only in the encrypted
 * store, the same rule the provider and account credentials follow.
 */
export const vccBrandSchema = z.enum(['visa', 'mastercard', 'amex', 'discover']);

export const vccCardStatusSchema = z.enum(['active', 'reserved', 'used', 'declined']);

/**
 * The issuer ranges the generator can be pointed at.
 *
 * A BIN is not a free-form number the operator types: which range a card is
 * minted under decides its brand, its length, whether it is accepted at all, and
 * how the issuer's own risk checks will treat it. Offering the ranges as a
 * catalogue — each with the facts that decide those things — is what makes the
 * choice a choice rather than a guess.
 */
export const vccBinTypeSchema = z.enum(['credit', 'debit', 'prepaid']);

export const vccBinSchema = z.object({
  /** Issuer identification number, the leading digits every card in the range shares. */
  bin: z.string().regex(/^\d{6,8}$/),
  brand: vccBrandSchema,
  /** The bank or issuer the range belongs to, as a person would name it. */
  issuer: z.string(),
  country: z.string(),
  /** ISO 3166-1 alpha-2, for the flag or the two-letter column. */
  countryCode: z.string().length(2),
  type: vccBinTypeSchema,
  /** ISO 4217; the currency a card in this range is denominated in. */
  currency: z.string().length(3),
  /** How long a number in this range is, so the generator can pad to it. */
  length: z.number().int().min(15).max(19),
  /**
   * How often the range is taken by the sign-up endpoints this pool is used
   * against, as a ratio. Not a guarantee — a hint for picking between two
   * otherwise identical ranges.
   */
  acceptance: z.number().min(0).max(1),
});

export const vccCardSchema = z.object({
  id: z.string(),
  brand: vccBrandSchema,
  /** Display form, e.g. `4111 •••• •••• 1111`. */
  maskedNumber: z.string(),
  last4: z.string().length(4),
  /** Issuer identification number the card was generated under. */
  bin: z.string(),
  /**
   * Whether a full number is held for this card.
   *
   * True for one rutekit minted, false for a card an operator recorded by hand
   * from an issuer that only gave them the masked form — which is the honest
   * state of a ledger entry. The reveal endpoint refuses the latter rather than
   * answering with an empty string, so a UI can hide the button instead of
   * offering one that does nothing.
   */
  hasPan: z.boolean().default(false),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int(),
  holderName: z.string(),
  country: z.string().nullable(),
  currency: z.string(),
  status: vccCardStatusSchema,
  /** Which generator produced the card, so a bad batch can be traced. */
  source: z.string(),
  /** Free-form label for whatever the card was spent on. */
  assignedTo: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * The full card details, for the one moment an operator needs them (FR-11.2).
 *
 * The pool's read model carries a masked number and the last four, because a
 * console that printed every PAN on a list would be a cardholder-data store with
 * a UI. But a card rutekit generated is useless if its number can never be read
 * back — an operator has to type it into a sign-up form — so this is the one
 * shape that carries the whole thing, behind its own endpoint, one card at a
 * time.
 *
 * `cvv` is stored with the PAN: a generated card that cannot produce a CVV is a
 * card that cannot be used at the endpoints this pool exists for, and the two
 * live and die together.
 */
export const vccRevealResultSchema = z.object({
  id: z.string(),
  /** The full number, ungrouped, as a form would want it typed. */
  pan: z.string(),
  /** The display grouping, so a UI can show both without re-deriving one. */
  formatted: z.string(),
  cvv: z.string(),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int(),
  holderName: z.string(),
});
export type VccRevealResult = z.infer<typeof vccRevealResultSchema>;

export type VccBrand = z.infer<typeof vccBrandSchema>;
export type VccCardStatus = z.infer<typeof vccCardStatusSchema>;
export type VccBinType = z.infer<typeof vccBinTypeSchema>;
export type VccBin = z.infer<typeof vccBinSchema>;
export type VccCard = z.infer<typeof vccCardSchema>;
