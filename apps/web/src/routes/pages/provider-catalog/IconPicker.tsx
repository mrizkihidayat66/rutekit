import { Check } from 'lucide-react';

import { ProviderIcon, PROVIDER_ICON_SLUGS } from '@web/components/patterns/ProviderIcon.tsx';
import { cn } from '@web/lib/cn.ts';

/**
 * The icon a BYOK provider wears in the catalog.
 *
 * A radio group rather than a select, because the choice *is* the picture — an
 * operator picking an icon wants to see the icons. It behaves like a radiogroup
 * to a keyboard: arrow keys move the selection and only the selected tile is a
 * tab stop, which is the same contract `SegmentedControl` keeps.
 */

interface IconPickerProps {
  readonly value: string;
  readonly onChange: (slug: string) => void;
}

export function IconPicker({ value, onChange }: IconPickerProps) {
  const move = (from: number, delta: number) => {
    const count = PROVIDER_ICON_SLUGS.length;
    const next = PROVIDER_ICON_SLUGS[(from + delta + count) % count];
    if (next !== undefined) onChange(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Provider icon"
      className="grid grid-cols-8 gap-1 rounded-control border border-border bg-surface-2 p-2"
      onKeyDown={(event) => {
        const index = PROVIDER_ICON_SLUGS.indexOf(value);
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          move(index, 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(index, -1);
        }
      }}
    >
      {PROVIDER_ICON_SLUGS.map((slug) => {
        const selected = slug === value;
        return (
          <button
            key={slug}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={slug}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(slug);
            }}
            className={cn(
              'relative flex items-center justify-center rounded-control p-1',
              'transition duration-(--dur-micro) ease-out outline-none',
              'focus-visible:ring-2 focus-visible:ring-focus',
              selected ? 'bg-accent/12' : 'hover:bg-surface-3',
            )}
          >
            <ProviderIcon icon={slug} size="sm" />
            {selected ? (
              <Check
                aria-hidden="true"
                className="absolute right-0.5 bottom-0.5 size-3 rounded-pill bg-accent text-accent-contrast"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
