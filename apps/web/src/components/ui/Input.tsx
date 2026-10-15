import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

const CONTROL =
  'w-full rounded-control border bg-surface-2 text-sm text-text placeholder:text-text-subtle ' +
  'transition duration-(--dur-micro) ease-out outline-none ' +
  'hover:border-border-strong focus:border-border-strong focus:bg-surface-3 ' +
  'disabled:cursor-not-allowed disabled:opacity-55';

const SIZES = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-9 px-3',
} as const;

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size'> {
  /** Paints the danger border and sets `aria-invalid`. */
  invalid?: boolean;
  inputSize?: keyof typeof SIZES;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export function Input({
  invalid = false,
  inputSize = 'md',
  leading,
  trailing,
  className,
  ...props
}: InputProps) {
  const control = (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        SIZES[inputSize],
        invalid ? 'border-danger/60 focus:border-danger' : 'border-border',
        leading ? 'pl-8' : undefined,
        trailing ? 'pr-8' : undefined,
        className,
      )}
      {...props}
    />
  );

  if (!leading && !trailing) return control;

  return (
    <div className="relative flex items-center">
      {leading ? (
        <span className="pointer-events-none absolute left-2.5 flex text-text-subtle [&_svg]:size-3.5">
          {leading}
        </span>
      ) : null}
      {control}
      {trailing ? (
        <span className="absolute right-2.5 flex text-text-subtle [&_svg]:size-3.5">{trailing}</span>
      ) : null}
    </div>
  );
}
