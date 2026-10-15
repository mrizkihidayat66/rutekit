import * as SliderPrimitive from '@radix-ui/react-slider';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '@web/lib/cn.ts';

export interface SliderProps extends ComponentPropsWithRef<typeof SliderPrimitive.Root> {
  /** Renders a filled range between two handles when given two values. */
  values?: number[];
}

export function Slider({ values, className, ...props }: SliderProps) {
  const handleCount = values?.length ?? 1;

  return (
    <SliderPrimitive.Root
      className={cn(
        'relative flex h-5 w-full touch-none select-none items-center',
        'data-[disabled]:opacity-55',
        className,
      )}
      {...(values === undefined ? {} : { value: values })}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-pill border border-border bg-surface-2">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>

      {Array.from({ length: handleCount }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          aria-label={props['aria-label'] ?? `Value ${index + 1}`}
          className={cn(
            'block size-4 rounded-pill border border-border-strong bg-surface-3 shadow-card',
            'transition duration-(--dur-micro) ease-spring',
            'hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            'disabled:pointer-events-none',
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}
