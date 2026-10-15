import type {
  DotTrickResult,
  SortDirection,
  VccBinType,
  VccBrand,
  VccCard,
  VccCardStatus,
} from '@contracts';

import type { Tone } from '@web/components/patterns/tone.ts';

/**
 * The Tools page's shared vocabulary.
 *
 * Kept out of the components so those files stay components-only for the
 * fast-refresh boundary, and so the two panels — which have almost nothing to do
 * with each other — agree on the few things they share: which section is open,
 * and what each panel's own words mean.
 *
 * The two sections are deliberately unlike one another. A dot trick is pure
 * arithmetic with no state to keep; the VCC pool is a list of rows that outlive
 * the visit. Putting them behind one segmented control is a filing decision, not
 * a claim that they are the same kind of thing.
 */

/* ---- Sections ---- */

export const SECTION_PARAM = 'tool';

export const SECTIONS = ['dot-trick', 'vcc'] as const;
export type ToolsSection = (typeof SECTIONS)[number];

export const DEFAULT_SECTION: ToolsSection = 'dot-trick';

export function isToolsSection(value: string): value is ToolsSection {
  return SECTIONS.includes(value as ToolsSection);
}

export const SECTION_LABELS: Record<ToolsSection, string> = {
  'dot-trick': 'Dot trick',
  vcc: 'VCC pool',
};

/* ---- Dot trick ---- */

/**
 * The three ways an address can be expanded.
 *
 * `both` is the default because it is what the trick is actually for: an address
 * that survives both spellings is an address that survives either filter, and an
 * operator who wanted only one of them can say so.
 */
export const DOT_MODES = ['dot', 'plus', 'both'] as const;
export type DotTrickMode = (typeof DOT_MODES)[number];

export const DOT_MODE_LABELS: Record<DotTrickMode, string> = {
  dot: 'Dots',
  plus: 'Plus tags',
  both: 'Both',
};

export const DOT_MODE_HINTS: Record<DotTrickMode, string> = {
  dot: 'Insert dots into the local part. Most mail providers treat them as the same mailbox.',
  plus: 'Append +tags to the local part. Fewer providers honour these, but they are exact.',
  both: 'Dots and plus tags together — every variant a provider is likely to accept.',
};

/** The contract's own ceiling, repeated here so the field can say what it is. */
export const MAX_VARIANTS = 512;
/**
 * The field's starting value: no cap.
 *
 * A cap is the wrong default here because the number is not something a person
 * can work out in advance — how many spellings an address has depends on how
 * many characters its local part has. Asking for a number before the list can be
 * seen means guessing, and a guess is what cuts the list short. Zero says "every
 * one of them", and the ceiling still stops it being unbounded.
 */
export const DEFAULT_VARIANT_LIMIT = '0';

export const DEFAULT_DOT_MODE: DotTrickMode = 'both';

/** Every variant, one per line — what "copy all" puts on the clipboard. */
export function variantsText(result: DotTrickResult): string {
  return result.variants.map((variant) => variant.address).join('\n');
}

/**
 * The variants as CSV.
 *
 * A spreadsheet is the reason this exists: the whole point of generating these is
 * to paste them into a sign-up sheet, and the technique column is kept because
 * which trick produced an address is the thing you need when one of them is
 * rejected.
 */
export function variantsCsv(result: DotTrickResult): string {
  const rows = result.variants.map((variant) => `${variant.address},${variant.technique}`);
  return ['address,technique', ...rows].join('\n');
}

/* ---- VCC pool ---- */

export const VCC_BRANDS: readonly VccBrand[] = ['visa', 'mastercard', 'amex', 'discover'];

export const VCC_BRAND_LABELS: Record<VccBrand, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
};

export const VCC_BIN_TYPE_LABELS: Record<VccBinType, string> = {
  credit: 'Credit',
  debit: 'Debit',
  prepaid: 'Prepaid',
};

/**
 * The four states a card moves through, in the order it moves through them.
 *
 * The list is a lifecycle rather than a set of categories: a card is minted
 * `active`, goes `reserved` while a sign-up is mid-flight, and finishes either
 * `used` or `declined`. Only a `reserved` card can go back to `active`; the two
 * terminal states are terminal. Ordering the filter this way means the dropdown
 * reads as the card's life, not as an alphabet.
 */
export const VCC_STATUSES: readonly VccCardStatus[] = [
  'active',
  'reserved',
  'used',
  'declined',
];

export const VCC_STATUS_LABELS: Record<VccCardStatus, string> = {
  active: 'Active',
  reserved: 'Reserved',
  used: 'Used',
  declined: 'Declined',
};

export const VCC_STATUS_TONES: Record<VccCardStatus, Tone> = {
  active: 'success',
  reserved: 'info',
  used: 'neutral',
  declined: 'danger',
};

export const VCC_STATUS_HINTS: Record<VccCardStatus, string> = {
  active: 'Minted and free — the next sign-up that needs a card can take it.',
  reserved: 'Held by a sign-up that is still in flight. It comes back to the pool if that run is abandoned.',
  used: 'Spent on a sign-up that succeeded. A used card is not free again.',
  declined: 'The issuer refused it. A declined card is finished and cannot be reused.',
};

/** The brand filter: any brand, or one of the four. */
export type VccBrandFilter = 'all' | VccBrand;

export const VCC_BRAND_FILTERS: readonly VccBrandFilter[] = ['all', ...VCC_BRANDS];

export function isVccBrandFilter(value: string): value is VccBrandFilter {
  return value === 'all' || VCC_BRANDS.includes(value as VccBrand);
}

export function vccBrandParam(filter: VccBrandFilter): VccBrand | null {
  return filter === 'all' ? null : filter;
}

/** The status filter: any state, or one of the four. */
export type VccStatusFilter = 'all' | VccCardStatus;

export const VCC_STATUS_FILTERS: readonly VccStatusFilter[] = ['all', ...VCC_STATUSES];

export function isVccStatusFilter(value: string): value is VccStatusFilter {
  return value === 'all' || VCC_STATUSES.includes(value as VccCardStatus);
}

export function vccStatusParam(filter: VccStatusFilter): VccCardStatus | null {
  return filter === 'all' ? null : filter;
}

/**
 * What the pool can be ordered by.
 *
 * Expiry leads the fields that are not the default, because an expiring card is
 * the one thing in this list that goes wrong on its own — everything else only
 * changes when somebody acts.
 */
export const VCC_SORT_KEYS = ['createdAt', 'expiryYear', 'brand', 'status', 'last4'] as const;
export type VccSortKey = (typeof VCC_SORT_KEYS)[number];

export const DEFAULT_VCC_SORT: VccSortKey = 'createdAt';

export function isVccSortKey(value: string): value is VccSortKey {
  return VCC_SORT_KEYS.includes(value as VccSortKey);
}

export const VCC_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

export function isVccDirection(value: string): value is SortDirection {
  return value === 'asc' || value === 'desc';
}

/** A card is one row and a pool is small, so a page is generous. */
export const VCC_PAGE_SIZE = 40;

export function vccNarrowed(
  search: string,
  brand: VccBrandFilter,
  status: VccStatusFilter,
): boolean {
  return search.trim() !== '' || brand !== 'all' || status !== 'all';
}

/**
 * When the card stops working, as `MM/YY`.
 *
 * Zero-padded because a column of dates is read down, not across, and `9/28`
 * beside `10/28` breaks the alignment that makes the column scannable.
 */
export function expiryLabel(card: VccCard): string {
  const month = String(card.expiryMonth).padStart(2, '0');
  const year = String(card.expiryYear % 100).padStart(2, '0');
  return `${month}/${year}`;
}

/** How much of a batch is still usable, as a ratio. */
export function activeShare(cards: readonly VccCard[]): number {
  if (cards.length === 0) return 0;
  return cards.filter((card) => card.status === 'active').length / cards.length;
}
