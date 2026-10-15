import type { Customization, CustomizationUpdate, GlassDepth } from '@contracts';

/**
 * The Customization page's vocabulary.
 *
 * Three small jobs, all of them about turning a record into controls and back:
 * the option lists a segmented control needs, the ranges the two sliders move
 * over, and the value the "reset" button restores. Keeping them here rather than
 * in the components is what lets the page read as composition.
 */

/* ---- Background media ---- */

export const BACKGROUND_KINDS = ['none', 'image', 'video'] as const;
export type BackgroundKind = (typeof BACKGROUND_KINDS)[number];

export const BACKGROUND_KIND_LABELS: Record<BackgroundKind, string> = {
  none: 'No background',
  image: 'Image background',
  video: 'Video background',
};

/**
 * What the browser will accept, spelled out for the file input and repeated in
 * the copy — an operator who drags a `.mov` onto the page should learn why it
 * did nothing without opening devtools.
 */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif';
export const VIDEO_ACCEPT = 'video/mp4,video/webm';
export const MEDIA_ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;
export const MEDIA_FORMATS = 'PNG, JPEG, WebP, AVIF, GIF, MP4 or WebM';
export const ICON_FORMATS = 'PNG, JPEG, WebP, AVIF or GIF';

/** Extensions a browser will play, for URLs that arrive without a media type. */
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogv'] as const;

/**
 * Which kind an asset is.
 *
 * There is no "image or video" switch on the page, because there does not need
 * to be one: the asset says what it is. A dropped file arrives as a data URL
 * whose media type is authoritative; a pasted URL is judged by its extension,
 * which is right far more often than a toggle an operator has to remember to
 * flip. The record's `backgroundKind` is therefore derived, and can never
 * disagree with `backgroundUrl`.
 */
export function mediaKindOf(url: string): Exclude<BackgroundKind, 'none'> {
  if (url.startsWith('data:')) return url.startsWith('data:video/') ? 'video' : 'image';
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.some((extension) => path.endsWith(extension)) ? 'video' : 'image';
}

/* ---- Cards ---- */

/** What every card on the page is handed. */
export interface AppearanceCardProps {
  readonly record: Customization;
  readonly disabled: boolean;
  readonly onChange: (patch: CustomizationUpdate) => void;
}

/* ---- Glass ---- */

export const GLASS_DEPTHS: readonly GlassDepth[] = [1, 2, 3];

export const GLASS_DEPTH_LABELS: Record<GlassDepth, string> = {
  1: 'Subtle',
  2: 'Medium',
  3: 'Deep',
};

export const GLASS_DEPTH_OPTIONS = GLASS_DEPTHS.map((value) => ({
  value: String(value),
  label: GLASS_DEPTH_LABELS[value],
}));

export function parseGlassDepth(value: string): GlassDepth | null {
  const parsed = Number.parseInt(value, 10);
  return parsed === 1 || parsed === 2 || parsed === 3 ? parsed : null;
}

/* ---- Sliders ---- */

/** Matches `customizationSchema`: opacity is a fraction, blur is pixels. */
export const OPACITY_RANGE = { min: 0, max: 1, step: 0.01 } as const;
export const BLUR_RANGE = { min: 0, max: 64, step: 1 } as const;

export function formatOpacity(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

export function formatBlur(value: number): string {
  return `${String(value)} px`;
}

/* ---- Reset ---- */

/**
 * The state the reset button restores. It mirrors `buildCustomization()` in the
 * mock fixtures on purpose: "reset" should land the operator on the console they
 * were given, not on a second opinion about what the defaults are.
 */
export const CUSTOMIZATION_DEFAULTS: Customization = {
  theme: 'system',
  brandingIconUrl: null,
  backgroundKind: 'none',
  backgroundUrl: null,
  backgroundOpacity: 0.5,
  backgroundBlurPx: 0,
  glassEnabled: true,
  glassDepth: 2,
  ambientGlow: true,
};
