import type { Customization } from '@contracts';

/**
 * Appearance settings, as attributes on `<html>`.
 *
 * Everything here is deliberately outside React. The operator sets a background
 * once and then reads a dozen pages; re-rendering the tree because an opacity
 * moved would be work for nothing, and the CSS that consumes these attributes
 * (`styles/app.css`) already keys off `data-*` for the theme for the same
 * reason. React's only job is to write them, and it writes them from a record
 * the API owns rather than from component state.
 *
 * Kept apart from the component that applies them so the mapping can be read —
 * and tested — without a DOM.
 */

/** What the shell needs to paint the media layer, as opposed to what CSS needs. */
export interface AppearanceMedia {
  readonly kind: 'image' | 'video';
  readonly url: string;
  readonly opacity: number;
  readonly blurPx: number;
}

/**
 * The record with its `null`s resolved.
 *
 * `backgroundKind` and `backgroundUrl` are two fields that can disagree — a URL
 * with no kind, or a kind with no URL — and the console should not paint half a
 * background in either case. Requiring both is what makes the rest of the code
 * free of `null` checks: either there is media, or there is not.
 */
export function appearanceMedia(customization: Customization): AppearanceMedia | null {
  const { backgroundKind, backgroundUrl } = customization;
  if (backgroundKind === 'none' || backgroundUrl === null || backgroundUrl === '') return null;
  return {
    kind: backgroundKind,
    url: backgroundUrl,
    opacity: customization.backgroundOpacity,
    blurPx: customization.backgroundBlurPx,
  };
}

export interface AppearanceAttributes {
  readonly 'data-app-background': 'true' | 'false';
  readonly 'data-glass-enabled': 'true' | 'false';
  readonly 'data-glass-depth': '1' | '2' | '3';
  readonly 'data-ambient-glow': 'true' | 'false';
}

/**
 * The four switches CSS reads. `data-app-background` is derived from the media
 * rather than from `backgroundKind` alone, so a kind without a URL cannot make
 * the shell translucent with nothing behind it.
 */
export function appearanceAttributes(customization: Customization): AppearanceAttributes {
  return {
    'data-app-background': appearanceMedia(customization) === null ? 'false' : 'true',
    'data-glass-enabled': customization.glassEnabled ? 'true' : 'false',
    'data-glass-depth': String(customization.glassDepth) as '1' | '2' | '3',
    'data-ambient-glow': customization.ambientGlow ? 'true' : 'false',
  };
}

const ATTRIBUTE_NAMES = [
  'data-app-background',
  'data-glass-enabled',
  'data-glass-depth',
  'data-ambient-glow',
] as const;

/**
 * Opacity and blur travel as custom properties rather than as React props.
 *
 * The two are the only appearance values that move continuously — an operator
 * drags the opacity slider and expects the background to follow under their
 * finger — and a CSS variable is what makes that a repaint instead of a
 * re-render. The media element reads them through `opacity-(--…)` and
 * `blur-(--…)`, so a drag updates one element's computed style and nothing else.
 */
export const MEDIA_OPACITY_VAR = '--app-background-opacity';
export const MEDIA_BLUR_VAR = '--app-background-blur';

/** Write the record onto `<html>`. Idempotent; safe to call on every change. */
export function applyAppearance(customization: Customization): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const attributes = appearanceAttributes(customization);
  for (const name of ATTRIBUTE_NAMES) {
    root.setAttribute(name, attributes[name]);
  }

  const media = appearanceMedia(customization);
  root.style.setProperty(MEDIA_OPACITY_VAR, String(media?.opacity ?? 1));
  root.style.setProperty(MEDIA_BLUR_VAR, `${String(media?.blurPx ?? 0)}px`);
}

/**
 * Clear what `applyAppearance` set.
 *
 * Only the dev showcase needs this, but leaving the attributes behind would be
 * worse than the function is long: they are read by rules that make the whole
 * console translucent, so a stale `true` follows the operator onto every page
 * until a reload.
 */
export function clearAppearance(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const name of ATTRIBUTE_NAMES) {
    root.removeAttribute(name);
  }
  root.style.removeProperty(MEDIA_OPACITY_VAR);
  root.style.removeProperty(MEDIA_BLUR_VAR);
}

/** Media types the browser can be trusted to play or draw. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm'];

export function isImageFile(file: File): boolean {
  return IMAGE_TYPES.includes(file.type);
}

export function isVideoFile(file: File): boolean {
  return VIDEO_TYPES.includes(file.type);
}

export function isMediaFile(file: File): boolean {
  return isImageFile(file) || isVideoFile(file);
}

/**
 * Read a dropped file into a data URL.
 *
 * A data URL is what lets the mock layer store a background at all — there is no
 * upload endpoint until the backend exists, and `File` itself cannot be put in a
 * JSON record. The consequence is honest and worth saying out loud on the page:
 * the URL is a few megabytes of base64 held in memory, so it survives until the
 * tab reloads and no longer. The size limit is what keeps that from being a way
 * to hang the browser.
 */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('The file could not be read as data.'));
    });
    reader.addEventListener('error', () => {
      reject(new Error('The file could not be read.'));
    });
    reader.readAsDataURL(file);
  });
}

/** Bytes → the largest file a data URL can hold without a visible stall. */
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_ICON_BYTES = 512 * 1024;
