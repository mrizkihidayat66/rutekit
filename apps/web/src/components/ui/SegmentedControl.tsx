import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

/**
 * A single-select segmented control.
 *
 * A row of options where exactly one is current. A segmented row reads that
 * instantly where a dropdown hides the options behind a click, so it is the
 * default for the small, fixed choices a page keeps in its header — a time
 * window, an outcome filter, a log level.
 *
 * It is a radio group rather than a set of toggle buttons (RULESET R4.6 is about
 * on/off switches): the arrow keys move the selection and `aria-checked` says
 * which one is current, so the whole row is a single tab stop rather than one
 * per option (RULESET R4.9).
 */

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  /** Trailing content, e.g. a count badge. */
  readonly trailing?: ReactNode;
  readonly disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  readonly value: T;
  readonly onValueChange: (next: T) => void;
  readonly options: readonly SegmentedOption<T>[];
  readonly size?: 'sm' | 'md';
  readonly 'aria-label': string;
  readonly className?: string;
}

const SIZES = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm',
} as const;

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size = 'sm',
  'aria-label': ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const enabled = options.filter((option) => option.disabled !== true);
  // The tab stop has to land on something even when the current value is
  // disabled or not in the list, or the group becomes unreachable by keyboard.
  const activeValue =
    options.find((option) => option.value === value && option.disabled !== true)?.value ??
    enabled[0]?.value;

  const select = (next: T) => {
    onValueChange(next);
    refs.current[options.findIndex((option) => option.value === next)]?.focus();
  };

  const step = (from: T, delta: number): T | null => {
    if (enabled.length === 0) return null;
    const currentIndex = enabled.findIndex((option) => option.value === from);
    const base = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (base + delta + enabled.length) % enabled.length;
    return enabled[nextIndex]?.value ?? null;
  };

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, current: T) => {
    let next: T | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = step(current, 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = step(current, -1);
    else if (event.key === 'Home') next = enabled[0]?.value ?? null;
    else if (event.key === 'End') next = enabled[enabled.length - 1]?.value ?? null;
    if (next === null) return;
    event.preventDefault();
    select(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-control border border-border bg-surface-2 p-0.5',
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            tabIndex={option.value === activeValue ? 0 : -1}
            onClick={() => {
              select(option.value);
            }}
            onKeyDown={(event) => {
              handleKey(event, option.value);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-control font-medium',
              'transition duration-(--dur-micro) ease-out outline-none',
              'focus-visible:ring-2 focus-visible:ring-focus',
              'disabled:pointer-events-none disabled:opacity-45',
              SIZES[size],
              selected ? 'bg-surface-3 text-text shadow-card' : 'text-text-muted hover:text-text',
            )}
          >
            {option.label}
            {option.trailing}
          </button>
        );
      })}
    </div>
  );
}
