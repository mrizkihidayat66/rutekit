import { cn } from '@web/lib/cn.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center rounded-control font-medium ' +
  'transition duration-(--dur-micro) ease-out active:scale-[0.98] ' +
  'disabled:pointer-events-none disabled:opacity-45';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-contrast hover:opacity-90',
  secondary: 'border border-border bg-surface-2 text-text hover:bg-surface-3',
  outline: 'border border-border-strong bg-transparent text-text hover:bg-surface-2',
  ghost: 'bg-transparent text-text-muted hover:bg-surface-2 hover:text-text',
  danger: 'bg-danger text-accent-contrast hover:opacity-90',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-9 gap-2 px-3.5 text-sm',
  lg: 'h-11 gap-2.5 px-5 text-base',
  icon: 'size-9 p-0',
};

export interface ButtonVariantOptions {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
}

/**
 * Class string for a button-shaped element. Lives outside `Button.tsx` so that
 * file exports components only (fast refresh), and so `<Link>` and `<label>`
 * can wear the same skin without an `asChild` wrapper.
 */
export function buttonVariants({ variant = 'primary', size = 'md' }: ButtonVariantOptions = {}): string {
  return cn(BASE, VARIANTS[variant], SIZES[size]);
}
