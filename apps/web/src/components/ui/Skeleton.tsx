import type { ComponentPropsWithRef } from 'react';

import { cn } from '@web/lib/cn.ts';

export interface SkeletonProps extends ComponentPropsWithRef<'div'> {
  /** Shorthand widths so call sites stay readable: `text`/`title`/`metric`. */
  shape?: 'text' | 'title' | 'metric' | 'block' | 'circle';
}

const SHAPES: Record<NonNullable<SkeletonProps['shape']>, string> = {
  text: 'h-3.5 w-full',
  title: 'h-5 w-40',
  metric: 'h-8 w-24',
  block: 'h-24 w-full rounded-card',
  circle: 'size-9 rounded-pill',
};

export function Skeleton({ shape = 'text', className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('skeleton', SHAPES[shape], className)}
      {...props}
    />
  );
}

/** A stack of text-shaped placeholders; the common "card is loading" case. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} shape="text" className={index === lines - 1 ? 'w-2/3' : undefined} />
      ))}
    </div>
  );
}
