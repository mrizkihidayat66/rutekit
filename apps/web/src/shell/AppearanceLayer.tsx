import { useEffect } from 'react';

import { useCustomization } from '@web/hooks/use-system.ts';
import { applyAppearance, appearanceMedia } from '@web/lib/appearance.ts';
import { cn } from '@web/lib/cn.ts';

/**
 * A blur samples past the element's own bounds, so a blurred full-bleed image
 * leaves a bright rim at every edge — the one artefact that makes a blurred
 * background look broken rather than soft. Scaling up is what buys the sampler
 * the pixels it needs; `scale-125` is applied only when there is a blur, because
 * on an unblurred image it would just crop the picture for nothing.
 *
 * The opacity and blur themselves come from custom properties on `<html>`, so
 * dragging a slider repaints this element instead of re-rendering the tree.
 */
const MEDIA_CLASS =
  'size-full object-cover blur-[var(--app-background-blur)] opacity-[var(--app-background-opacity)]';

/**
 * The console's appearance, applied.
 *
 * Two jobs, and they are the same job: read the operator's record, write it onto
 * `<html>` so the CSS can act on it, and paint the media the CSS cannot paint on
 * its own — a video background is an element, not a `background-image`.
 *
 * It sits at the very bottom of the stacking order (`app-background`), so every
 * page above it is unaware that it exists. That is deliberate: a background each
 * page had to leave room for would be a background half the pages forget.
 *
 * The record is applied in an effect rather than during render because it writes
 * to `document`, and the write is idempotent — the same record applied twice
 * leaves the same attributes behind, so a re-render costs nothing.
 */
export function AppearanceLayer() {
  const customization = useCustomization();
  const record = customization.data;

  useEffect(() => {
    if (record === undefined) return;
    applyAppearance(record);
  }, [record]);

  if (record === undefined) return null;
  const media = appearanceMedia(record);

  // The glow is independent of the media: an operator can light the page without
  // putting anything behind it, which is why it is not nested inside the media
  // branch.
  if (media === null && !record.ambientGlow) return null;

  return (
    <div className="app-background" aria-hidden="true">
      {media === null ? null : media.kind === 'video' ? (
        <video
          className={cn(MEDIA_CLASS, media.blurPx > 0 && 'scale-125')}
          src={media.url}
          autoPlay
          loop
          muted
          playsInline
        />
      ) : (
        <img
          className={cn(MEDIA_CLASS, media.blurPx > 0 && 'scale-125')}
          src={media.url}
          alt=""
        />
      )}

      {record.ambientGlow ? <div className="ambient-glow absolute inset-0" /> : null}
    </div>
  );
}
