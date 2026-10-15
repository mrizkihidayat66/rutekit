import type { ComponentPropsWithRef } from 'react';

import { buttonVariants, type ButtonVariantOptions } from '@web/components/ui/button-variants.ts';
import { cn } from '@web/lib/cn.ts';

export interface ButtonProps extends ComponentPropsWithRef<'button'>, ButtonVariantOptions {
  /** Renders a spinner and blocks interaction without changing the label width. */
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  type = 'button',
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="size-3.5 animate-spin-slow rounded-pill border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
