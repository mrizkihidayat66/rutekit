import { Check, Minus } from 'lucide-react';
import { useEffect, useRef, type ComponentPropsWithRef } from 'react';

import { cn } from '@web/lib/cn.ts';

/**
 * The console's checkbox.
 *
 * A native `<input type="checkbox">` wearing the design system, rather than a
 * rebuilt one: it keeps the browser's own keyboard behaviour, its focus ring and
 * its `:indeterminate` state (RULESET R4.1) — none of which a `div` with a click
 * handler gets for free.
 *
 * `indeterminate` is passed as a prop but applied as a *property*: it has no
 * HTML attribute, so React cannot set it declaratively, and a select-all box
 * that silently loses its third state would misreport the selection.
 */

export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {
  /** Draw the "some but not all" state. Ignored while `checked` is true. */
  readonly indeterminate?: boolean;
}

export function Checkbox({ indeterminate = false, className, ...props }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          'peer size-4 cursor-pointer appearance-none rounded-key border border-border-strong bg-surface-2',
          'transition-colors duration-(--dur-micro) ease-out outline-none',
          'checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent',
          'hover:border-accent focus-visible:ring-2 focus-visible:ring-focus',
          'disabled:cursor-not-allowed disabled:opacity-55',
          className,
        )}
        {...props}
      />
      <Check
        aria-hidden="true"
        className="pointer-events-none absolute size-3 text-accent-contrast opacity-0 transition-opacity duration-(--dur-micro) peer-checked:opacity-100"
      />
      <Minus
        aria-hidden="true"
        className="pointer-events-none absolute size-3 text-accent-contrast opacity-0 transition-opacity duration-(--dur-micro) peer-indeterminate:opacity-100 peer-checked:opacity-0"
      />
    </span>
  );
}
