import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '@web/lib/cn.ts';

export const Tabs = TabsPrimitive.Root;

export type TabsVariant = 'segmented' | 'underline';

export interface TabsListProps extends ComponentPropsWithRef<typeof TabsPrimitive.List> {
  variant?: TabsVariant;
}

export function TabsList({ variant = 'segmented', className, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex items-center',
        variant === 'segmented'
          ? 'gap-0.5 rounded-control border border-border bg-surface-2 p-0.5'
          : 'gap-4 border-b border-border',
        className,
      )}
      {...props}
    />
  );
}

export interface TabsTriggerProps extends ComponentPropsWithRef<typeof TabsPrimitive.Trigger> {
  variant?: TabsVariant;
}

export function TabsTrigger({ variant = 'segmented', className, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium',
        'transition duration-(--dur-micro) ease-out outline-none',
        'text-text-muted hover:text-text',
        'disabled:pointer-events-none disabled:opacity-45',
        variant === 'segmented'
          ? cn(
              'rounded-control px-3 py-1',
              'data-[state=active]:bg-surface-3 data-[state=active]:text-text data-[state=active]:shadow-card',
            )
          : cn(
              '-mb-px border-b-2 border-transparent px-0.5 pb-2',
              'data-[state=active]:border-accent data-[state=active]:text-text',
            ),
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('outline-none animate-fade-in', className)}
      {...props}
    />
  );
}
