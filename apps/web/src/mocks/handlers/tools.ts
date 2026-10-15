import { http } from '../net.ts';
import type {
  VccCard,
} from '@contracts';
import {
  dotTrickBodySchema,
  dotTrickResultSchema,
  vccCardSchema,
  vccRevealResultSchema,
  vccCardUpdateSchema,
  vccCardsResponseSchema,
  vccBinsResponseSchema,
  vccGenerateBodySchema,
  vccGenerateResultSchema,
} from '@contracts';

import { db, matches, paginate, sortBy } from '../db.ts';
import { isoAt } from '../clock.ts';
import { buildVccBins, maskedNumber } from '../fixtures/tools.ts';
import {
  badRequest,
  bodyOf,
  listParams,
  notFound,
  paramId,
  respond,
  route,
  searchParams,
  strParam,
  uid,
} from './helpers.ts';

/**
 * Tools section: Studio, Benchmark, Model Verification, Tools.
 *
 * Chat is in the same nav section but not in this file: its backend landed in C9
 * while the other three are still to come, and a mock domain is what goes live at
 * once — see `handlers/chat.ts`.
 */

/**
 * The contract's ceiling on dot-trick output.
 *
 * `limit: 0` means "no caller cap" rather than "nothing", so this is what stops
 * an unbounded request — the caller gets everything up to here and the result
 * says so via `truncated`.
 */
const MAX_DOT_VARIANTS = 512;

function dotVariants(local: string, limit: number): string[] {
  const gaps = local.length - 1;
  if (gaps < 1) return [];
  const results: string[] = [];
  const total = 2 ** gaps;
  for (let mask = 1; mask < total && results.length < limit; mask += 1) {
    let out = local.slice(0, 1);
    for (let index = 0; index < gaps; index += 1) {
      if (((mask >> index) & 1) === 1) out += '.';
      out += local.slice(index + 1, index + 2);
    }
    results.push(out);
  }
  return results;
}

/**
 * The Tools section's local utilities: the dot trick and the card pool.
 *
 * The other pages in this nav section are not in this file. Chat, Studio,
 * Benchmark and Model Verification each landed in their own group with their own
 * backend, and a mock domain is what goes live at once — so each is its own
 * module (`handlers/chat.ts`, `handlers/studio.ts`, `handlers/benchmark.ts`,
 * `handlers/verification.ts`) and this one is what remains.
 */
export const toolHandlers = [
  /**
   * Expand an address into its variants.
   *
   * `limit: 0` is "everything the mode can spell", which is the default because
   * the number is not something an operator can guess — it depends on how many
   * characters the local part has, and asking someone to work that out before
   * they can see the list defeats the point. The ceiling is applied here rather
   * than trusted to the caller.
   */
  http.post(route('dotTrick'), async ({ request }) => {
    const body = dotTrickBodySchema.parse(await bodyOf(request));
    const at = body.email.lastIndexOf('@');
    const localPart = body.email.slice(0, at);
    const domain = body.email.slice(at + 1);
    const cap = body.limit === 0 ? MAX_DOT_VARIANTS : Math.min(body.limit, MAX_DOT_VARIANTS);

    // One more than the cap, so a list that filled it exactly can be told from one
    // that was cut — asking for exactly `cap` would make `truncated` unreachable
    // for a dot-only expansion, because the cut happens inside this call.
    const dots = body.mode === 'dot' || body.mode === 'both' ? dotVariants(localPart, cap + 1) : [];
    const plusTags = ['rc', 'alt', 'probe', 'x1', 's2'];
    const pluses =
      body.mode === 'plus' || body.mode === 'both' ? plusTags.map((tag) => `${localPart}+${tag}`) : [];

    // Alternated rather than concatenated, so that when the cap does bite it
    // takes from both techniques instead of exhausting the dots first. Asking
    // for "both" and being handed a page of dots is not an answer to the
    // question that was asked.
    const variants: Array<{ address: string; technique: 'dot' | 'plus' }> = [];
    for (let index = 0; index < Math.max(dots.length, pluses.length); index += 1) {
      const dot = dots[index];
      if (dot !== undefined) variants.push({ address: `${dot}@${domain}`, technique: 'dot' });
      const plus = pluses[index];
      if (plus !== undefined) variants.push({ address: `${plus}@${domain}`, technique: 'plus' });
    }
    const capped = variants.slice(0, cap);

    return respond(dotTrickResultSchema, {
      input: body.email,
      localPart,
      domain,
      variants: capped,
      truncated: variants.length > capped.length,
    });
  }),

  /**
   * The issuer ranges a batch can be minted under.
   *
   * Registered before `/tools/vcc/:id` on purpose: MSW resolves to the first
   * match, so a literal segment that comes after the parameterised route would
   * never be reached and the picker would get a 404 for a card called "bins".
   */
  http.get(route('vccBins'), () => respond(vccBinsResponseSchema, { bins: buildVccBins() })),

  http.get(route('vccCards'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const brand = strParam(params, 'brand');
    const status = strParam(params, 'status');
    const q = params.get('q') ?? '';

    let items = db.vccCards;
    if (brand !== null) items = items.filter((entry) => entry.brand === brand);
    if (status !== null) items = items.filter((entry) => entry.status === status);
    items = items.filter((entry) => matches([entry.last4, entry.maskedNumber, entry.holderName, entry.id, entry.assignedTo], q));

    return respond(vccCardsResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('vccGenerate'), async ({ request }) => {
    const body = vccGenerateBodySchema.parse(await bodyOf(request));
    const bins = buildVccBins();
    const brandBins = bins.filter((entry) => entry.brand === body.brand);
    const chosen =
      (body.bin === null ? null : brandBins.find((entry) => entry.bin === body.bin)) ??
      brandBins.reduce((best, entry) => (entry.acceptance > best.acceptance ? entry : best));
    const cards: VccCard[] = [];
    for (let index = 0; index < body.count; index += 1) {
      const last4 = String(1000 + ((Date.now() + index * 977) % 9000));
      const card: VccCard = {
        id: uid('vcc'),
        brand: chosen.brand,
        maskedNumber: maskedNumber(chosen.bin, last4, chosen.length),
        last4,
        hasPan: true,
        bin: chosen.bin,
        expiryMonth: 1 + ((index * 5) % 12),
        expiryYear: 2028 + (index % 3),
        holderName: body.holderName ?? 'Generated Card',
        country: chosen.countryCode,
        currency: chosen.currency,
        status: 'active',
        source: 'console-generate',
        assignedTo: null,
        note: null,
        createdAt: isoAt(0),
        updatedAt: isoAt(0),
      };
      db.vccCards.unshift(card);
      cards.push(card);
    }
    return respond(vccGenerateResultSchema, { cards });
  }),

  http.get(route('vccCard'), ({ params }) => {
    const card = db.vccCard(paramId(params));
    return card === undefined ? notFound('vcc card', paramId(params)) : respond(vccCardSchema, card);
  }),

  /**
   * The one place a full number leaves the API (FR-11.2).
   *
   * The mock has no encrypted store, so what it can honestly reproduce is the
   * *shape* of the answer: a number as long as the card's masked form, built from
   * its own BIN and last four, grouped the way a form field expects. A card with
   * no number behind it is refused rather than answered with an empty string —
   * the same rule the real endpoint follows, so a UI written against this behaves
   * the same way against the server.
   */
  http.get(route('vccReveal'), ({ params }) => {
    const card = db.vccCard(paramId(params));
    if (card === undefined) return notFound('vcc card', paramId(params));
    if (!card.hasPan) return badRequest('this card has no number stored');

    // The masked form carries the digits, so its length is the number's length.
    const length = card.maskedNumber.replace(/\D/gu, '').length;
    const middle = '0'.repeat(Math.max(0, length - card.bin.length - card.last4.length));
    const pan = `${card.bin}${middle}${card.last4}`;

    return respond(vccRevealResultSchema, {
      id: card.id,
      pan,
      formatted: pan.replace(/(.{4})/gu, '$1 ').trim(),
      cvv: '123',
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      holderName: card.holderName,
    });
  }),

  http.patch(route('vccCard'), async ({ params, request }) => {
    const patch = vccCardUpdateSchema.parse(await bodyOf(request));
    const updated = db.updateVccCard(paramId(params), patch);
    return updated === undefined ? notFound('vcc card', paramId(params)) : respond(vccCardSchema, updated);
  }),
];
