import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

const SIZES = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-9 px-3 text-sm',
} as const;

export interface SelectTriggerProps
  extends ComponentPropsWithRef<typeof SelectPrimitive.Trigger> {
  size?: keyof typeof SIZES | undefined;
  invalid?: boolean | undefined;
}

export function SelectTrigger({
  size = 'md',
  invalid = false,
  className,
  children,
  ...props
}: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      aria-invalid={invalid || undefined}
      className={cn(
        'group inline-flex w-full items-center justify-between gap-2 rounded-control border bg-surface-2',
        'text-text transition duration-(--dur-micro) ease-out outline-none',
        'hover:border-border-strong data-[placeholder]:text-text-subtle',
        'focus:border-border-strong focus:bg-surface-3',
        'disabled:cursor-not-allowed disabled:opacity-55',
        invalid ? 'border-danger/60 focus:border-danger' : 'border-border',
        SIZES[size],
        className,
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-3.5 shrink-0 text-text-subtle transition duration-(--dur-micro) ease-out group-data-[state=open]:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={6}
        className={cn(
          'z-50 max-h-72 min-w-32 overflow-hidden rounded-card border border-border',
          'bg-surface-3 text-text shadow-popover',
          'data-[state=open]:animate-scale-in data-[state=closed]:animate-fade-in',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="scrollbar-none p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-control py-1.5 pl-2.5 pr-8',
        'text-sm text-text outline-none',
        'data-[highlighted]:bg-surface-2 data-[state=checked]:font-medium',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 flex">
        <Check className="size-3.5 text-success" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({
  className,
  ...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn('px-2.5 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-text-subtle', className)}
      {...props}
    />
  );
}

export function SelectSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn('my-1 h-px bg-border', className)} {...props} />;
}

/** Convenience wrapper for the common "list of plain options" case. */
export interface SimpleSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: ReactNode; disabled?: boolean }>;
  placeholder?: string;
  size?: keyof typeof SIZES;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function SimpleSelect({
  value,
  onValueChange,
  options,
  placeholder,
  size,
  invalid,
  disabled,
  className,
  ...props
}: SimpleSelectProps) {
  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <SelectTrigger
        size={size}
        invalid={invalid}
        className={className}
        {...(props['aria-label'] ? { 'aria-label': props['aria-label'] } : {})}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
