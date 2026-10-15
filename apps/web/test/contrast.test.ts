import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Text contrast, measured rather than eyeballed (NFR-6).
 *
 * NFR-6 requires WCAG AA — 4.5:1 for body text — and the design tokens already
 * document that they were tuned for it: `app.css` carries a comment explaining
 * why the four semantic colours each have a separate `-text` binding. What was
 * missing is anything that *checks* it. A palette is exactly the kind of thing
 * that drifts silently: one hex nudged to make a chart look better, and a label
 * somewhere becomes unreadable, with no test to notice and no obvious symptom
 * until somebody cannot read the console.
 *
 * So this reads the tokens out of the stylesheet and computes the ratios. It is
 * arithmetic, not a rendering check — `jsdom` has no layout and no colour
 * compositing, so an axe run cannot see contrast at all. Doing it from the token
 * values is both more accurate and independent of whether anything mounted.
 *
 * **The chip is the worst case, and it is the one that matters.** A status chip
 * paints `bg-<name>/12` behind its word, and that tint pulls the background
 * toward the text colour — so a label that clears AA on a card can fail on a
 * chip over the page. The composited tint is computed here rather than assumed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, '..', 'src', 'styles', 'app.css'), 'utf8');

/** WCAG AA for body text. Large text (≥18.66px bold or ≥24px) is allowed 3:1. */
const AA_TEXT = 4.5;
/** AA for large text, and for a non-text graphic like a bar, a dot or a border. */
const AA_GRAPHIC = 3;

type Rgb = readonly [number, number, number];

function parseHex(value: string): Rgb {
  const hex = value.replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance. The 0.03928 knee and the 2.4 exponent are the spec. */
function luminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgb, background: Rgb): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** A translucent fill over an opaque one, as a browser would composite it. */
function over(color: Rgb, alpha: number, background: Rgb): Rgb {
  return [
    Math.round(color[0] * alpha + background[0] * (1 - alpha)),
    Math.round(color[1] * alpha + background[1] * (1 - alpha)),
    Math.round(color[2] * alpha + background[2] * (1 - alpha)),
  ];
}

/**
 * Every `--color-*: #hex` in one block, keyed by the name after `color-`.
 *
 * The prefix is dropped so the assertions read as the utility names the app
 * actually writes (`text-text-muted`, `bg-surface-2`), which is the vocabulary a
 * reader of this file already has.
 */
function themeTokens(block: string): Readonly<Record<string, Rgb>> {
  const tokens: Record<string, Rgb> = {};
  for (const [, name, value] of block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8});/g)) {
    if (name !== undefined && value !== undefined) tokens[name] = parseHex(value);
  }
  return tokens;
}

/**
 * Where the dark re-binding starts.
 *
 * Matched at the start of a line rather than by `indexOf`, because the selector
 * is also *mentioned* in the file's opening comment — and `indexOf` found that
 * first, which made the light block an empty slice and every light assertion
 * fail for the wrong reason.
 */
const DARK_AT = CSS.search(/^\[data-theme='dark'\]\s*\{/m);

const LIGHT_BLOCK = CSS.slice(CSS.indexOf('@theme {'), DARK_AT);
const DARK_BLOCK = CSS.slice(DARK_AT, CSS.indexOf('@layer', DARK_AT));

const LIGHT = themeTokens(LIGHT_BLOCK);
const DARK = themeTokens(DARK_BLOCK);

// The dark block is found by a literal selector in the stylesheet, and a rename
// there would silently make `DARK` a copy of `LIGHT` — every dark assertion then
// passing against light values, which is worse than failing.
if (Object.keys(DARK).length === 0 || DARK['text'] === LIGHT['text']) {
  throw new Error(
    "the dark theme could not be read: `[data-theme='dark']` was not found in app.css, or it no longer rebinds --color-text",
  );
}

/** The surfaces a label can land on, worst-case last. */
const SURFACES = ['page', 'surface-1', 'surface-2', 'surface-3'] as const;

/** The four semantic colours that have both a fill and a text role. */
const SEMANTIC = ['success', 'danger', 'warning', 'info'] as const;

function ratio(theme: Readonly<Record<string, Rgb>>, fg: string, bg: Rgb): number {
  const foreground = theme[fg];
  if (foreground === undefined) throw new Error(`token --${fg} is not defined in this theme`);
  return contrast(foreground, bg);
}

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
] as const)('contrast in the %s theme', (name, theme) => {
  it('defines every token both themes need', () => {
    // A theme missing a token does not fail loudly — it inherits the other
    // theme's value through the cascade and renders a light colour on a dark
    // surface. Asserting the inventory is what makes that impossible.
    for (const token of [
      'text',
      'text-muted',
      'text-subtle',
      'accent',
      'accent-contrast',
      ...SEMANTIC,
    ]) {
      expect(theme[token], `${name} is missing --color-${token}`).toBeDefined();
    }
    for (const surface of SURFACES) {
      expect(theme[surface], `${name} is missing --color-${surface}`).toBeDefined();
    }
    for (const semantic of SEMANTIC) {
      expect(
        theme[`${semantic}-text`],
        `${name} is missing --color-${semantic}-text`,
      ).toBeDefined();
    }
  });

  it('carries body text at AA on every surface', () => {
    const failures: string[] = [];
    for (const surface of SURFACES) {
      const background = theme[surface];
      if (background === undefined) continue;
      const value = ratio(theme, 'text', background);
      if (value < AA_TEXT)
        failures.push(`--color-text on --color-${surface}: ${value.toFixed(2)}:1`);
    }
    expect(failures).toEqual([]);
  });

  it('carries muted and subtle text at AA on every surface', () => {
    // The two quieter text roles are the ones that get nudged for aesthetics, so
    // they are the ones worth pinning. They are still body text: a table cell's
    // secondary line, a field's description, a timestamp.
    const failures: string[] = [];
    for (const role of ['text-muted', 'text-subtle']) {
      for (const surface of SURFACES) {
        const background = theme[surface];
        if (background === undefined) continue;
        const value = ratio(theme, role, background);
        if (value < AA_TEXT)
          failures.push(`--color-${role} on --color-${surface}: ${value.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('carries the accent label at AA on the accent fill', () => {
    // A primary button, a selected tab, an active nav row. This is the pairing
    // that has to hold for the console's main call to action.
    expect(ratio(theme, 'accent-contrast', theme['accent'] as Rgb)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('carries each semantic label at AA on the tinted chip it actually lands on', () => {
    // The real case, and the reason this file composites rather than guessing:
    // a chip paints `bg-<name>/12` behind its word, over whichever surface the
    // chip sits on. The tint pulls the background toward the text colour, so the
    // chip over the *page* is the tightest pairing in the whole palette.
    const failures: string[] = [];
    for (const semantic of SEMANTIC) {
      const fill = theme[semantic];
      const page = theme['page'];
      if (fill === undefined || page === undefined) continue;

      const chipOnPage = over(fill, 0.12, page);
      const value = ratio(theme, `${semantic}-text`, chipOnPage);
      if (value < AA_TEXT) {
        failures.push(
          `--color-${semantic}-text on a chip over --color-page: ${value.toFixed(2)}:1`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps each semantic fill legible as a graphic', () => {
    // The other half of the two-role split `app.css` describes: a bar, a stroke
    // or a status dot needs 3:1 against the surface behind it, not 4.5:1.
    const failures: string[] = [];
    for (const semantic of SEMANTIC) {
      const fill = theme[semantic];
      if (fill === undefined) continue;
      for (const surface of ['page', 'surface-1'] as const) {
        const background = theme[surface];
        if (background === undefined) continue;
        const value = contrast(fill, background);
        if (value < AA_GRAPHIC) {
          failures.push(`--color-${semantic} on --color-${surface}: ${value.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * The border ratios, recorded rather than required.
   *
   * **This is a known gap, not a passing check.** WCAG 1.4.11 asks for 3:1 on a
   * control's boundary, and `--color-border-strong` — which is what an input,
   * a checkbox and a slider thumb use for their resting and hover edges — sits
   * at 1.57:1 in light and 2.11:1 in dark against the page. `--color-border` is
   * lower still.
   *
   * It is deliberately not fixed here. The palette is a designed one with its own
   * comments explaining how each value was tuned, and raising these two would
   * change how every input in the console looks — a design decision, not a
   * correctness fix, and one deliberately deferred. What matters is that the
   * numbers cannot drift unnoticed: a palette change that makes the gap *worse*
   * fails here, and one that closes it also fails, because the recorded value is
   * what the test pins.
   *
   * The measured values are rounded to two places, so a change smaller than a
   * rounding step is not a failure — this pins the shape of the palette, not its
   * last bit.
   */
  it('records the control-border ratios, which are a known gap', () => {
    const measured: Record<string, number> = {};
    for (const border of ['border', 'border-strong'] as const) {
      for (const surface of SURFACES) {
        const background = theme[surface];
        if (background === undefined) continue;
        measured[`${border}/${surface}`] = Number(
          contrast(theme[border] as Rgb, background).toFixed(2),
        );
      }
    }

    // Recorded on 2026-10-15. Every one of these is below the 3:1 WCAG asks for.
    expect(measured).toEqual(
      name === 'light'
        ? {
            'border/page': 1.28,
            'border/surface-1': 1.39,
            'border/surface-2': 1.4,
            'border/surface-3': 1.41,
            'border-strong/page': 1.57,
            'border-strong/surface-1': 1.7,
            'border-strong/surface-2': 1.72,
            'border-strong/surface-3': 1.73,
          }
        : {
            'border/page': 1.6,
            'border/surface-1': 1.36,
            'border/surface-2': 1.26,
            'border/surface-3': 1.14,
            'border-strong/page': 2.11,
            'border-strong/surface-1': 1.79,
            'border-strong/surface-2': 1.67,
            'border-strong/surface-3': 1.5,
          },
    );

    // Stated once, so the gap is visible in the test output rather than only in
    // this comment.
    for (const [pair, value] of Object.entries(measured)) {
      expect(
        value,
        `${pair} is at ${String(value)}:1 — below the 3:1 WCAG 1.4.11 asks for`,
      ).toBeLessThan(AA_GRAPHIC);
    }
  });

  it('carries the console log’s text on its own surface', () => {
    // The log pane has its own recessed surface, so it is a pairing nothing else
    // in this file covers.
    expect(ratio(theme, 'term-fg', theme['term-bg'] as Rgb)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
