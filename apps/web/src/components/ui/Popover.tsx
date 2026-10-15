import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '@web/lib/cn.ts';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export interface PopoverContentProps
  extends ComponentPropsWithRef<typeof PopoverPrimitive.Content> {
  /** Removes the default padding for content that manages its own (tables, lists). */
  flush?: boolean;
}

export function PopoverContent({
  className,
  align = 'end',
  sideOffset = 8,
  flush = false,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-popover rounded-card border border-border bg-surface-3 text-text shadow-popover outline-none',
          'data-[state=open]:animate-scale-in data-[state=closed]:animate-fade-in',
          !flush && 'p-3',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
