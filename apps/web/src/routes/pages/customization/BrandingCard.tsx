import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { isImageFile, MAX_ICON_BYTES } from '@web/lib/appearance.ts';
import { formatBytes } from '@web/lib/format.ts';

import { MediaDropzone } from './MediaDropzone.tsx';
import { ICON_FORMATS, IMAGE_ACCEPT, type AppearanceCardProps } from './customization.ts';

function validateIcon(file: File): string | null {
  if (!isImageFile(file)) return `That is not an image the browser can draw. Use ${ICON_FORMATS}.`;
  if (file.size > MAX_ICON_BYTES) {
    return `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_ICON_BYTES)}.`;
  }
  return null;
}

/**
 * The mark in the rail.
 *
 * It replaces the default route glyph rather than sitting beside it, and the
 * sidebar drops its accent fill when one is set — most brand icons are
 * full-colour, and tinting one with the accent would turn a logo into a
 * silhouette. The swatch below the dropzone is the sidebar's own mark at the
 * size it is actually drawn.
 */
export function BrandingCard({ record, disabled, onChange }: AppearanceCardProps) {
  const iconUrl = record.brandingIconUrl;

  return (
    <Card>
      <CardHeader
        title="Branding"
        description="The mark at the top of the sidebar. Leave it empty to keep the default route glyph."
      />

      <div className="mt-3 flex flex-col gap-3">
        <MediaDropzone
          label="Icon"
          description="A square image reads best — it is drawn at 32 px."
          accept={IMAGE_ACCEPT}
          formats={ICON_FORMATS}
          maxBytes={MAX_ICON_BYTES}
          url={iconUrl}
          placeholder="https://example.com/icon.png"
          disabled={disabled}
          validate={validateIcon}
          onChange={(url) => {
            onChange({ brandingIconUrl: url });
          }}
          onClear={() => {
            onChange({ brandingIconUrl: null });
          }}
        />

        {iconUrl === null ? null : (
          <div className="flex items-center gap-3 rounded-card border border-border bg-surface-2 p-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-control bg-surface-3">
              <img src={iconUrl} alt="" className="size-full object-contain" />
            </span>
            <p className="min-w-0 text-xs text-text-muted">
              Drawn in the sidebar rail, at the size shown here.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
