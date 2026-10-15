import { cn } from '@web/lib/cn.ts';

import { TONE_GRAPHIC, type Tone } from './tone.ts';

/**
 * A trend at a glance, with no axes and no interaction.
 *
 * It sits inside a stat tile, where the exact numbers are already spelled out
 * above it and the only question left is "which way is this going". Because it
 * answers that question rather than carrying data, it is decorative by default
 * and is hidden from assistive technology unless a label is passed.
 *
 * The viewBox is stretched to the box and the strokes carry
 * `vector-effect="non-scaling-stroke"`, so the line stays a hairline however
 * wide the tile gets — no measurement, no resize observer.
 */

export interface SparklineProps {
  readonly values: readonly number[];
  readonly tone?: Tone;
  /** A description for assistive technology; omit to mark it decorative. */
  readonly ariaLabel?: string;
  readonly className?: string;
}

const VIEW_W = 100;
const VIEW_H = 32;
const PAD = 3;

function buildPaths(values: readonly number[]): { readonly line: string; readonly area: string } | null {
  if (values.length < 2) return null;

  let max = Math.max(...values);
  let min = Math.min(...values);
  // A flat series has no range to normalise against; give it a nominal one so
  // the line lands in the middle instead of collapsing onto an edge.
  if (max === min) {
    max += 1;
    min -= 1;
  }
  const span = max - min;
  const stepX = VIEW_W / (values.length - 1);

  const points = values.map((value, index) => {
    const x = index * stepX;
    const y = PAD + (1 - (value - min) / span) * (VIEW_H - PAD * 2);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  });

  const line = `M ${points.join(' L ')}`;
  return { line, area: `${line} L ${VIEW_W} ${VIEW_H} L 0 ${VIEW_H} Z` };
}

export function Sparkline({ values, tone = 'accent', ariaLabel, className }: SparklineProps) {
  const paths = buildPaths(values);
  const labelProps =
    ariaLabel === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': ariaLabel };

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      className={cn('h-8 w-full', TONE_GRAPHIC[tone], className)}
      {...labelProps}
    >
      {paths === null ? (
        <line
          x1={0}
          y1={VIEW_H / 2}
          x2={VIEW_W}
          y2={VIEW_H / 2}
          stroke="currentColor"
          strokeOpacity={0.3}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <>
          <path d={paths.area} fill="currentColor" fillOpacity={0.14} />
          <path
            d={paths.line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}
