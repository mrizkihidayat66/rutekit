import type {
  SearchQuery,
  VccBin,
  VccCard,
  VccCardStatus,
  VccCardUpdate,
  VccCardsQuery,
  VccCardsResponse,
  VccGenerateBody,
  VccGenerateResult,
  VccRevealResult,
} from '@contracts';
import { vccBrandSchema, vccCardStatusSchema } from '@contracts';
import type { RandomSource } from '@shared';

import { AppError } from '@server/errors.ts';
import type { VccCardRow, VccCardsRepository } from '@server/persistence/vcc.ts';
import { requireSecrets } from '@server/providers/oauth/resolve.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import { chooseBin, vccBins } from './bins.ts';
import { completeNumber, groupedNumber, maskedNumber } from './luhn.ts';

/**
 * The virtual-card pool (C8, FR-11.2).
 *
 * Cards are minted in batches and drawn down as provider sign-ups need one, so
 * the page is a pool rather than a wallet: what matters is which cards are free,
 * which are out with a sign-up, and which the issuer refused.
 *
 * **The number is written once and read once.** Generation encrypts the PAN and
 * its CVV into the row and returns only the masked form; the reveal endpoint is
 * the single path that opens an envelope, and it does it one card at a time
 * because that is the shape of the need — an operator typing one number into one
 * form. The read model carries `hasPan` so a UI can hide the button on a card
 * that has no number behind it.
 *
 * **The lifecycle is enforced, not merely recorded.** The four states are a
 * one-way street in practice, and a `used` card going back to `active` would put
 * a spent card back in the pool for the next sign-up to draw. The transitions
 * that are allowed are the ones the roadmap names, and the refusal names both
 * states.
 */

/** How long a generated card is valid for, in years from now. */
const CARD_LIFETIME_YEARS = 3;

export interface VccService {
  list(query: VccCardsQuery): VccCardsResponse;
  bins(): readonly VccBin[];
  get(id: string): VccCard;
  /** Mint a batch under one issuer range. */
  generate(body: VccGenerateBody): VccGenerateResult;
  update(id: string, patch: VccCardUpdate): VccCard;
  remove(id: string): void;
  /** The full number, for the one card an operator is about to spend. */
  reveal(id: string): VccRevealResult;
}

export interface VccServiceDeps {
  readonly cards: VccCardsRepository;
  readonly secrets: SecretBox | null;
  /** Injectable so a batch is reproducible in a test. */
  readonly random: RandomSource;
  readonly now?: () => Date;
}

/**
 * The transitions a card may make.
 *
 * `active` is where a card starts and where a released reservation returns;
 * `used` and `declined` are terminal, because a spent card that came back would
 * be handed to the next sign-up. A card may be re-reserved from `active` as many
 * times as it is abandoned — which is what a failed sign-up leaves behind.
 */
const TRANSITIONS: Readonly<Record<VccCardStatus, readonly VccCardStatus[]>> = {
  active: ['reserved', 'used', 'declined'],
  reserved: ['active', 'used', 'declined'],
  used: [],
  declined: [],
};

/** A stored row as the console's contract. Never carries a number. */
export function toVccCard(row: VccCardRow): VccCard {
  return {
    id: row.id,
    brand: vccBrandSchema.safeParse(row.brand).data ?? 'visa',
    maskedNumber: row.maskedNumber,
    last4: row.last4,
    bin: row.bin,
    hasPan: row.hasPan,
    expiryMonth: row.expiryMonth,
    expiryYear: row.expiryYear,
    holderName: row.holderName,
    country: row.country,
    currency: row.currency,
    status: vccCardStatusSchema.safeParse(row.status).data ?? 'active',
    source: row.source,
    assignedTo: row.assignedTo,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SORTERS: Record<string, (row: VccCardRow) => string | number> = {
  brand: (row) => row.brand,
  status: (row) => row.status,
  last4: (row) => row.last4,
  expiryYear: (row) => row.expiryYear,
  createdAt: (row) => row.createdAt,
  assignedTo: (row) => row.assignedTo ?? '',
};

export function createVccService(deps: VccServiceDeps): VccService {
  const now = deps.now ?? ((): Date => new Date());

  function require(id: string): VccCardRow {
    const row = deps.cards.findById(id);
    if (row === null) throw AppError.notFound(`No card with id ${id}.`);
    return row;
  }

  /** `n` decimal digits, from the injected source. */
  function digits(count: number): number[] {
    const bytes = deps.random(count);
    const out: number[] = [];
    for (let index = 0; index < count; index += 1) {
      // `% 10` over a byte is very slightly biased toward 0–5, which for a
      // synthetic card body is not a distribution anybody is measuring.
      out.push((bytes[index] ?? 0) % 10);
    }
    return out;
  }

  return {
    list(query: VccCardsQuery): VccCardsResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.cards.listAll();

      if (query.brand !== null) rows = rows.filter((row) => row.brand === query.brand);
      if (query.status !== null) rows = rows.filter((row) => row.status === query.status);
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.last4, row.bin, row.holderName, row.assignedTo, row.note].some(
            (value) => value !== null && value.toLowerCase().includes(needle),
          ),
        );
      }

      const sorted = sortRows(rows, query);
      const offset = offsetOf(query.cursor);
      return paginate(sorted.map(toVccCard), offset, query.limit);
    },

    bins(): readonly VccBin[] {
      return vccBins();
    },

    get(id: string): VccCard {
      return toVccCard(require(id));
    },

    generate(body: VccGenerateBody): VccGenerateResult {
      const bin = chooseBin(body.brand, body.bin);
      if (bin === null) {
        // A named BIN that does not belong to the brand asked for is a
        // contradiction: a card cannot be a Visa minted under an Amex range.
        throw AppError.invalidRequest(
          body.bin === null
            ? `No issuer range is known for ${body.brand}.`
            : `${body.bin} is not a ${body.brand} range.`,
        );
      }

      const box = requireSecrets(deps.secrets);
      const at = now();
      const stamp = at.toISOString();
      const cards: VccCard[] = [];

      for (let index = 0; index < body.count; index += 1) {
        const pan = completeNumber(bin.bin, digits(bin.length - 1 - bin.bin.length), bin.length);
        // Three digits, the conventional CVV length for every brand here. Amex
        // prints four on the front, and a generated Amex with a three-digit one
        // would fail the form it is typed into.
        const cvv = digits(bin.brand === 'amex' ? 4 : 3).map(String).join('');
        const last4 = pan.slice(-4);

        const row = deps.cards.create({
          id: crypto.randomUUID(),
          brand: bin.brand,
          bin: bin.bin,
          last4,
          maskedNumber: maskedNumber(bin.bin, last4, bin.length),
          panEnvelope: box.encrypt(pan),
          cvvEnvelope: box.encrypt(cvv),
          hasPan: true,
          // A card that expires next month is a card nobody can use, so the
          // lifetime starts at a whole year out rather than at the current month.
          expiryMonth: 1 + ((at.getMonth() + index) % 12),
          expiryYear: at.getFullYear() + CARD_LIFETIME_YEARS,
          holderName: body.holderName ?? 'Generated Card',
          country: bin.countryCode,
          currency: bin.currency,
          status: 'active',
          source: 'console-generate',
          assignedTo: null,
          note: null,
          createdAt: stamp,
          updatedAt: stamp,
        });
        cards.push(toVccCard(row));
      }

      return { cards };
    },

    update(id: string, patch: VccCardUpdate): VccCard {
      const row = require(id);
      const at = now().toISOString();

      if (patch.status !== undefined) {
        const from = vccCardStatusSchema.safeParse(row.status).data ?? 'active';
        if (from !== patch.status && !TRANSITIONS[from].includes(patch.status)) {
          // Refused rather than recorded: a spent card that went back to `active`
          // would be handed to the next sign-up, which is the one thing the
          // lifecycle exists to prevent.
          throw AppError.invalidRequest(`A ${from} card cannot become ${patch.status}.`);
        }
      }

      deps.cards.update(
        id,
        { status: patch.status, assignedTo: patch.assignedTo, note: patch.note },
        at,
      );
      return toVccCard(require(id));
    },

    remove(id: string): void {
      require(id);
      deps.cards.delete(id);
    },

    reveal(id: string): VccRevealResult {
      const row = require(id);
      if (!row.hasPan || row.panEnvelope === null || row.cvvEnvelope === null) {
        // A card recorded by hand from a masked form has no number to show, and
        // saying so beats answering with an empty string a UI would render as a
        // card with no digits.
        throw AppError.invalidRequest(
          'This card has no number stored — it was recorded from a masked form.',
        );
      }

      const box = requireSecrets(deps.secrets);
      const pan = box.decrypt(row.panEnvelope);
      return {
        id: row.id,
        pan,
        formatted: groupedNumber(pan),
        cvv: box.decrypt(row.cvvEnvelope),
        expiryMonth: row.expiryMonth,
        expiryYear: row.expiryYear,
        holderName: row.holderName,
      };
    },
  };
}

/** Apply the query's sort, or leave the order alone when it named none. */
function sortRows(rows: readonly VccCardRow[], query: SearchQuery): VccCardRow[] {
  const sorter = SORTERS[query.sort ?? ''];
  if (sorter === undefined) return [...rows];

  const direction = query.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sorter(a);
    const right = sorter(b);
    if (left === right) return a.id.localeCompare(b.id);
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return order * direction;
  });
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function paginate<TItem>(
  items: readonly TItem[],
  offset: number,
  limit: number,
): { items: TItem[]; nextCursor: string | null; total: number } {
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    nextCursor: next < items.length ? String(next) : null,
    total: items.length,
  };
}
