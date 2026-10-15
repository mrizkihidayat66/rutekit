import { cn } from '@web/lib/cn.ts';

/**
 * The dropdown under a chip field that is offering names it already knows.
 *
 * Kept apart from `ChipList` because it holds no state: the field owns what is
 * typed, which option is highlighted and whether the list is showing, and hands
 * all three down. That way the ARIA combobox wiring lives in one file and the
 * listbox markup in another, and neither is long enough to hide a mistake in.
 *
 * Options are plain `role="option"` rows rather than buttons, following the ARIA
 * 1.2 combobox pattern the command palette already uses: focus stays in the
 * input and the highlighted row is announced through `aria-activedescendant`.
 */

export interface SuggestionListProps {
  /** Goes on the `<ul>`, for the input's `aria-controls`. */
  readonly id: string;
  readonly label: string;
  readonly options: readonly string[];
  readonly activeIndex: number;
  /** The `id` of the option at `index`, for `aria-activedescendant`. */
  readonly optionId: (index: number) => string;
  readonly emptyText: string;
  readonly onActiveIndexChange: (index: number) => void;
  readonly onPick: (value: string) => void;
}

export function SuggestionList({
  id,
  label,
  options,
  activeIndex,
  optionId,
  emptyText,
  onActiveIndexChange,
  onPick,
}: SuggestionListProps) {
  if (options.length === 0) {
    return (
      <div className="absolute z-popover mt-1 w-full rounded-card border border-border bg-surface-3 px-2.5 py-2 text-[0.6875rem] text-text-muted shadow-popover">
        {emptyText}
      </div>
    );
  }

  return (
    <ul
      id={id}
      role="listbox"
      aria-label={label}
      className="absolute z-popover mt-1 max-h-56 w-full overflow-y-auto rounded-card border border-border bg-surface-3 p-1 shadow-popover"
    >
      {options.map((option, index) => {
        const active = index === activeIndex;
        return (
          <li
            key={option}
            id={optionId(index)}
            role="option"
            aria-selected={active}
            onMouseMove={() => {
              onActiveIndexChange(index);
            }}
            onMouseDown={(event) => {
              // Keep focus in the input: a real blur would commit the half-typed
              // text as a free value a moment before the pick lands.
              event.preventDefault();
              onPick(option);
            }}
            className={cn(
              'cursor-pointer truncate rounded-control px-2.5 py-1.5 font-mono text-xs',
              active ? 'bg-surface-2 text-text' : 'text-text-muted',
            )}
          >
            {option}
          </li>
        );
      })}
    </ul>
  );
}
