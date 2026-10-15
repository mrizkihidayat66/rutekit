import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '@web/lib/cn.ts';

const SIZES = {
  sm: { track: 'h-4 w-7', thumb: 'size-3 data-[state=checked]:translate-x-3' },
  md: { track: 'h-5 w-9', thumb: 'size-4 data-[state=checked]:translate-x-4' },
} as const;

export interface SwitchProps extends ComponentPropsWithRef<typeof SwitchPrimitive.Root> {
  size?: keyof typeof SIZES;
}

export function Switch({ size = 'md', className, ...props }: SwitchProps) {
  const metrics = SIZES[size];

  return (
    <SwitchPrimitive.Root
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer items-center rounded-pill border border-border',
        'bg-surface-2 transition duration-(--dur-micro) ease-out',
        'data-[state=checked]:border-transparent data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-55',
        metrics.track,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none ml-0.5 block rounded-pill bg-page shadow-card',
          'transition duration-(--dur-micro) ease-spring',
          metrics.thumb,
        )}
      />
    </SwitchPrimitive.Root>
  );
}
