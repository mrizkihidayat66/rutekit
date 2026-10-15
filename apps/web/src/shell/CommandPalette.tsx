import { CornerDownLeft, Moon, Palette, Search, type LucideIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { useModalFocus } from '@web/hooks/useModalFocus.ts';
import { usePresence } from '@web/hooks/usePresence.ts';
import { cn } from '@web/lib/cn.ts';
import { applyTheme, readThemePreference, resolveTheme } from '@web/lib/theme.ts';
import { NAV_ITEMS, navSectionOf } from '@web/shell/nav-config.ts';

const EXIT_MS = 150;

interface Command {
  id: string;
  label: string;
  /** Right-aligned qualifier: the section for a page, or the kind for an action. */
  hint: string;
  icon: LucideIcon;
  keywords: readonly string[];
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * ⌘K palette, built on the shared overlay contract (RULESET R3.8) and the ARIA
 * 1.2 combobox pattern: focus never leaves the input, and the highlighted row is
 * announced through `aria-activedescendant`. Options are therefore plain
 * `role="option"` elements rather than buttons — that is the pattern, not a
 * shortcut around keyboard operability.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { mounted, closing } = usePresence(open, EXIT_MS);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const baseId = useId();
  const listId = `${baseId}-list`;

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useModalFocus({
    active: open && mounted,
    containerRef,
    onEscape: close,
    initialFocusRef: inputRef,
  });

  const commands = useMemo<readonly Command[]>(
    () => [
      ...NAV_ITEMS.map((item) => ({
        id: `nav:${item.id}`,
        label: item.label,
        hint: navSectionOf(item)?.label ?? 'Go to',
        icon: item.icon,
        keywords: item.keywords,
        run: (): void => {
          void navigate(item.path);
        },
      })),
      {
        id: 'action:theme',
        label: 'Switch to light / dark theme',
        hint: 'Action',
        icon: Moon,
        keywords: ['theme', 'dark', 'light', 'appearance', 'colour'],
        run: (): void => {
          applyTheme(resolveTheme(readThemePreference()) === 'dark' ? 'light' : 'dark');
        },
      },
      {
        id: 'action:design',
        label: 'Open design system showcase',
        hint: 'Internal',
        icon: Palette,
        keywords: ['design', 'tokens', 'components', 'showcase', 'swatches'],
        run: (): void => {
          void navigate('/dev/design');
        },
      },
    ],
    [navigate],
  );

  const results = useMemo<readonly Command[]>(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return commands;
    return commands.filter(
      (command) =>
        command.label.toLowerCase().includes(needle) ||
        command.hint.toLowerCase().includes(needle) ||
        command.keywords.some((keyword) => keyword.includes(needle)),
    );
  }, [commands, query]);

  // A fresh query should always start at the top of its result set.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
  }, [open]);

  // Shrinking the list must not strand the highlight past the end.
  useEffect(() => {
    setActiveIndex((index) =>
      results.length === 0 ? 0 : Math.min(index, results.length - 1),
    );
  }, [results.length]);

  // Keep the highlighted row on screen as the user arrows through.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const runCommand = useCallback(
    (command: Command | undefined): void => {
      if (!command) return;
      command.run();
      close();
    },
    [close],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const count = results.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => (count === 0 ? 0 : (index + 1) % count));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => (count === 0 ? 0 : (index - 1 + count) % count));
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(Math.max(0, count - 1));
        break;
      case 'Enter':
        event.preventDefault();
        runCommand(results[activeIndex]);
        break;
      case 'Tab':
        // The palette holds a single field; Tab means "leave", not "cycle".
        event.preventDefault();
        close();
        break;
      default:
        break;
    }
  };

  if (!mounted) return null;

  const activeId = results.length > 0 ? `${baseId}-opt-${activeIndex}` : undefined;

  return createPortal(
    <div className="fixed inset-0 z-command flex items-start justify-center p-4 pt-[10vh]">
      <button
        type="button"
        aria-label="Close command menu"
        onClick={close}
        className={cn(
          'absolute inset-0 cursor-default bg-scrim backdrop-blur-[2px]',
          closing ? 'animate-fade-out' : 'animate-fade-in',
        )}
      />

      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        className={cn(
          'relative w-full max-w-lg overflow-hidden rounded-card border border-border bg-surface-3 shadow-dialog',
          closing ? 'animate-fade-out' : 'animate-scale-in',
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search commands"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search pages and actions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-subtle"
          />
          <kbd className="shrink-0 rounded-key border border-border bg-surface-2 px-1 text-[0.625rem] leading-4 text-text-subtle">
            esc
          </kbd>
        </div>

        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Commands"
          className="scrollbar-none max-h-80 overflow-y-auto p-1.5"
        >
          {results.map((command, index) => {
            const Icon = command.icon;
            const active = index === activeIndex;
            return (
              <li
                key={command.id}
                id={`${baseId}-opt-${index}`}
                data-index={index}
                role="option"
                aria-selected={active}
                onMouseMove={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  // Prevent the input from losing focus before the command runs.
                  event.preventDefault();
                  runCommand(command);
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-2 text-sm',
                  active ? 'bg-surface-2 text-text' : 'text-text-muted',
                )}
              >
                <Icon
                  className={cn('size-4 shrink-0', active ? 'text-text' : 'text-text-subtle')}
                  aria-hidden="true"
                />
                <span className="flex-1 truncate">{command.label}</span>
                <span className="shrink-0 text-[0.6875rem] text-text-subtle">{command.hint}</span>
              </li>
            );
          })}
        </ul>

        {results.length === 0 ? (
          <p role="status" className="px-3 py-6 text-center text-xs text-text-muted">
            No commands match “{query.trim()}”.
          </p>
        ) : null}

        <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-[0.6875rem] text-text-subtle">
          <span className="flex items-center gap-1">
            <kbd className="rounded-key border border-border bg-surface-2 px-1 leading-4">↑</kbd>
            <kbd className="rounded-key border border-border bg-surface-2 px-1 leading-4">↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <CornerDownLeft className="size-3" aria-hidden="true" />
            select
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
