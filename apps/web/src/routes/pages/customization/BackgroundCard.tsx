import type { ReactNode } from 'react';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { Slider } from '@web/components/ui/Slider.tsx';
import { MAX_MEDIA_BYTES, isMediaFile } from '@web/lib/appearance.ts';
import { formatBytes } from '@web/lib/format.ts';

import { MediaDropzone } from './MediaDropzone.tsx';
import {
  BACKGROUND_KIND_LABELS,
  BLUR_RANGE,
  MEDIA_ACCEPT,
  MEDIA_FORMATS,
  OPACITY_RANGE,
  formatBlur,
  formatOpacity,
  mediaKindOf,
  type AppearanceCardProps,
} from './customization.ts';

function validateMedia(file: File): string | null {
  if (!isMediaFile(file)) return `That is not an image or a video. Use ${MEDIA_FORMATS}.`;
  if (file.size > MAX_MEDIA_BYTES) {
    return `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_MEDIA_BYTES)}.`;
  }
  return null;
}

/** A labelled slider. The wrapper is the label, so the control needs no id. */
function RangeField({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-text-muted">{label}</span>
        <span className="text-[0.6875rem] text-text-subtle tabular-nums">{hint}</span>
      </span>
      {children}
    </label>
  );
}

/**
 * What sits behind everything.
 *
 * There is no "image or video" switch here, and that is the design: the asset
 * says which it is, so an operator cannot set the record to `video` while
 * pointing at a PNG. Clearing the dropzone is what turns the background off —
 * `backgroundKind` goes back to `none` and the console returns to an opaque
 * page.
 *
 * Opacity and blur only move the media layer. Blur is the one that needs
 * explaining: a blurred image samples past its own edges, which leaves a bright
 * rim, so the layer is scaled up whenever a blur is set. That is why the preview
 * crops slightly once the slider leaves zero.
 */
export function BackgroundCard({ record, disabled, onChange }: AppearanceCardProps) {
  const hasBackground = record.backgroundKind !== 'none' && record.backgroundUrl !== null;

  const setBackground = (url: string): void => {
    onChange({ backgroundUrl: url, backgroundKind: mediaKindOf(url) });
  };

  const clearBackground = (): void => {
    onChange({ backgroundUrl: null, backgroundKind: 'none' });
  };

  return (
    <Card>
      <CardHeader
        title="Background"
        description="An image or a video behind the whole console. Pages stay legible on top of it."
        actions={
          <Badge tone={hasBackground ? 'accent' : 'neutral'} size="sm">
            {BACKGROUND_KIND_LABELS[record.backgroundKind]}
          </Badge>
        }
      />

      <div className="mt-3 flex flex-col gap-4">
        <MediaDropzone
          label="Media"
          description="Dropped files are held in memory until the backend can store them, so they last until you reload."
          accept={MEDIA_ACCEPT}
          formats={MEDIA_FORMATS}
          maxBytes={MAX_MEDIA_BYTES}
          url={record.backgroundUrl}
          placeholder="https://example.com/background.mp4"
          disabled={disabled}
          validate={validateMedia}
          onChange={setBackground}
          onClear={clearBackground}
        />

        <div className={hasBackground ? 'flex flex-col gap-4' : 'flex flex-col gap-4 opacity-55'}>
          <RangeField label="Opacity" hint={formatOpacity(record.backgroundOpacity)}>
            <Slider
              values={[record.backgroundOpacity]}
              min={OPACITY_RANGE.min}
              max={OPACITY_RANGE.max}
              step={OPACITY_RANGE.step}
              disabled={disabled || !hasBackground}
              aria-label="Background opacity"
              onValueChange={(next) => {
                const first = next[0];
                if (first !== undefined) onChange({ backgroundOpacity: first });
              }}
            />
          </RangeField>

          <RangeField label="Blur" hint={formatBlur(record.backgroundBlurPx)}>
            <Slider
              values={[record.backgroundBlurPx]}
              min={BLUR_RANGE.min}
              max={BLUR_RANGE.max}
              step={BLUR_RANGE.step}
              disabled={disabled || !hasBackground}
              aria-label="Background blur"
              onValueChange={(next) => {
                const first = next[0];
                if (first !== undefined) onChange({ backgroundBlurPx: first });
              }}
            />
          </RangeField>
        </div>

        {hasBackground ? null : (
          <p className="text-[0.6875rem] text-text-subtle">
            Add an image or a video to unlock opacity and blur.
          </p>
        )}
      </div>
    </Card>
  );
}
