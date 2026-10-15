import type { CSSProperties } from 'react';

/**
 * The one shape of inline style the design system permits (RULESET R3.4): a
 * style object whose keys are *all* CSS custom properties. Values that are
 * genuinely dynamic — a measured offset, a swatch previewed in the showcase —
 * have to travel through a custom property; anything else belongs in a class.
 */
export type CSSVars = CSSProperties & Record<`--${string}`, string | number>;
