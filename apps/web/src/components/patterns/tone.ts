/**
 * The tone vocabulary shared by the chart and metric patterns.
 *
 * Kept beside the primitives rather than inside each one so a sparkline, a
 * meter and a stat tile in the same card always resolve "warning" to the same
 * token — the alternative is three local maps that drift apart the first time
 * one of them is touched.
 *
 * Every value is a `text-*` or `bg-*` utility over a design token, never a
 * literal colour (RULESET R3.1): the palette is re-themed from `app.css` alone.
 */

export type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info';

/**
 * Graphic foreground — a stroke, an icon or a dot that follows `currentColor`.
 *
 * These are the plain colour tokens, which are tuned as fills: WCAG asks only
 * 3:1 of a graphic, and every one of them clears that. They are *not* for words —
 * use `TONE_LABEL` for those.
 */
export const TONE_GRAPHIC: Record<Tone, string> = {
  neutral: 'text-text-muted',
  accent: 'text-accent',
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
};

/**
 * Text foreground — a word, a level label, a figure.
 *
 * Binds to the `-text` variants, which are darker in light theme precisely so a
 * sentence in a semantic colour clears the 4.5:1 that text needs (NFR-6). Kept
 * separate from `TONE_GRAPHIC` because the two roles cannot share one value.
 */
export const TONE_LABEL: Record<Tone, string> = {
  neutral: 'text-text-muted',
  accent: 'text-accent',
  success: 'text-success-text',
  danger: 'text-danger-text',
  warning: 'text-warning-text',
  info: 'text-info-text',
};

/** A soft chip: background, text and border together. */
export const TONE_CHIP: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-text-muted border-border',
  accent: 'bg-accent/10 text-accent border-accent/25',
  success: 'bg-success/12 text-success-text border-success/25',
  danger: 'bg-danger/12 text-danger-text border-danger/25',
  warning: 'bg-warning/14 text-warning-text border-warning/30',
  info: 'bg-info/12 text-info-text border-info/25',
};

/** A solid fill — for a meter's bar or a bar list's row. */
export const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-text-muted',
  accent: 'bg-accent',
  success: 'bg-success',
  danger: 'bg-danger',
  warning: 'bg-warning',
  info: 'bg-info',
};

/**
 * How spent a `0..1` ratio is, as a tone.
 *
 * One definition so a credit pool, an account's quota cell and a quota window in
 * the same view all agree on when "nearly gone" turns amber and when "gone" turns
 * red. The thresholds are deliberately the same everywhere: an operator reading
 * two bars side by side must not have to learn two scales.
 */
export function usageTone(ratio: number): Tone {
  if (ratio >= 0.95) return 'danger';
  if (ratio >= 0.8) return 'warning';
  return 'accent';
}
