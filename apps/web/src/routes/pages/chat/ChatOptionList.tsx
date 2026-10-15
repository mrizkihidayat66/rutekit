import { Check, Search } from 'lucide-react';
import { useState } from 'react';

import { Input } from '@web/components/ui/Input.tsx';
import { cn } from '@web/lib/cn.ts';

/**
 * A single-choice list that can be narrowed by typing.
 *
 * Both lists this serves run well past a screen — the provider catalog alone is
 * over a hundred entries — and a long list with no way to filter it is the one
 * thing a popover does worse than the native select it replaced, which at least
 * jumped to a typed letter. The filter is what keeps that from being a
 * regression, so it is part of the component rather than something a caller
 * remembers to add.
 *
 * `value` is a plain string and `''` means "none of these". These are buttons
 * rather than a Radix select, so an empty value carries no special meaning and
 * reads better than a sentinel every call site has to map back.
 *
 * `aria-pressed` rather than `role="option"`: a listbox promises arrow-key
 * navigation and focus management that these buttons do not implement, and
 * claiming a role the keyboard does not honour is worse than claiming none.
 */

export interface ChatOption {
  readonly value: string;
  readonly label: string;
  /** Shown after the label, muted — the provider a model belongs to, say. */
  readonly detail?: string;
}

export interface ChatOptionListProps {
  readonly label: string;
  readonly options: readonly ChatOption[];
  readonly selected: string;
  readonly onSelect: (value: string) => void;
  readonly searchPlaceholder: string;
  readonly emptyLabel: string;
  readonly pending?: boolean;
}

export function ChatOptionList({
  label,
  options,
  selected,
  onSelect,
  searchPlaceholder,
  emptyLabel,
  pending = false,
}: ChatOptionListProps) {
  const [search, setSearch] = useState('');

  const needle = search.trim().toLowerCase();
  const shown =
    needle === ''
      ? options
      : options.filter((option) =>
          `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(needle),
        );

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[0.6875rem] font-medium tracking-wide text-text-subtle uppercase">
        {label}
      </span>

      <Input
        inputSize="sm"
        value={search}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        leading={<Search aria-hidden="true" />}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />

      {shown.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-text-subtle">{pending ? 'Loading…' : emptyLabel}</p>
      ) : (
        <div
          role="group"
          aria-label={label}
          className="scrollbar-none flex max-h-36 flex-col gap-0.5 overflow-y-auto"
        >
          {shown.map((option) => {
            const active = option.value === selected;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onSelect(option.value);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs outline-none',
                  'transition duration-(--dur-micro) ease-out focus-visible:ring-2 focus-visible:ring-focus',
                  active ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.detail === undefined ? null : (
                  <span className="shrink-0 font-mono text-[0.625rem] text-text-subtle">
                    {option.detail}
                  </span>
                )}
                {active ? <Check aria-hidden="true" className="size-3.5 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
