import type { ReactNode } from 'react';

import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { ThemeToggle } from '@web/components/ThemeToggle.tsx';
import { cn } from '@web/lib/cn.ts';

import {
  GLASS_DEPTH_LABELS,
  GLASS_DEPTH_OPTIONS,
  parseGlassDepth,
  type AppearanceCardProps,
} from './customization.ts';

function Row({
  label,
  description,
  control,
  className,
}: {
  label: string;
  description: string;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-medium text-text">{label}</span>
        <span className="text-[0.6875rem] text-text-subtle">{description}</span>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/**
 * How the surfaces behave, and which palette they are drawn in.
 *
 * Glass and glow are separate switches rather than one "effects" toggle because
 * they do different things to different layers: glass makes the surfaces
 * translucent so the background shows through them, and the glow is a light
 * source of its own that needs no background at all.
 *
 * Depth is the one setting worth a sentence of explanation, because "1 / 2 / 3"
 * says nothing. Depth moves how much of the background reaches the surface, and
 * the surface's own tint rises with it — a more transparent panel needs a
 * stronger wash to stay readable. So depth 3 is at once the most see-through and
 * the most tinted, which is why the three are ordered rather than named.
 */
export function EffectsCard({ record, disabled, onChange }: AppearanceCardProps) {
  const hasBackground = record.backgroundKind !== 'none' && record.backgroundUrl !== null;
  const glassUsable = hasBackground && record.glassEnabled;

  return (
    <Card>
      <CardHeader
        title="Effects"
        description="How surfaces sit over the background, and which palette the console is drawn in."
      />

      <div className="mt-3 flex flex-col gap-4">
        <Row
          label="Theme"
          description="Applied across the console and remembered in this browser."
          control={<ThemeToggle />}
        />

        <Row
          label="Glass"
          description="Lets the background show through cards, panels and the sidebar."
          control={
            <Switch
              checked={record.glassEnabled}
              disabled={disabled}
              aria-label="Glass"
              onCheckedChange={(checked) => {
                onChange({ glassEnabled: checked });
              }}
            />
          }
        />

        <div className={cn('flex flex-col gap-1.5', glassUsable ? '' : 'opacity-55')}>
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-text-muted">Depth</span>
            <span className="text-[0.6875rem] text-text-subtle">
              {GLASS_DEPTH_LABELS[record.glassDepth]}
            </span>
          </span>
          <SegmentedControl
            value={String(record.glassDepth)}
            options={GLASS_DEPTH_OPTIONS}
            aria-label="Glass depth"
            className={cn(!glassUsable && 'pointer-events-none')}
            onValueChange={(value) => {
              const depth = parseGlassDepth(value);
              if (depth !== null) onChange({ glassDepth: depth });
            }}
          />
        </div>

        <Row
          label="Ambient glow"
          description="Two soft washes of light in opposite corners. Works with or without a background."
          control={
            <Switch
              checked={record.ambientGlow}
              disabled={disabled}
              aria-label="Ambient glow"
              onCheckedChange={(checked) => {
                onChange({ ambientGlow: checked });
              }}
            />
          }
        />

        {hasBackground ? null : (
          <p className="text-[0.6875rem] text-text-subtle">
            Glass needs a background behind it — set one above to see it take effect.
          </p>
        )}
      </div>
    </Card>
  );
}
