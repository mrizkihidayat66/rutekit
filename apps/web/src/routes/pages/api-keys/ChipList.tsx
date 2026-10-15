import { X } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';

import { SuggestionList } from './SuggestionList.tsx';

/**
 * A list of names edited as chips, optionally against a vocabulary the console
 * already knows.
 *
 * Model ids and client labels are short, exact strings that an operator pastes
 * in bunches and removes one at a time. A single text field would hide how many
 * there are and would make removing the third of five an exercise in counting
 * commas, so each name gets its own chip with its own remove button.
 *
 * The field commits on Enter, on a comma, on a space, and on blur — the four
 * ways someone finishes typing a name without meaning to keep going. What is
 * still half-typed is handed back through `text` rather than swallowed, so a
 * name in progress survives until it is either committed or the form is closed.
 *
 * Backspace on an empty field removes the last chip, which is the convention
 * every tag input has trained people to expect.
 *
 * When `suggestions` is given the field becomes a combobox over that list: what
 * is typed narrows it, a pick commits one of its names exactly, and a committed
 * name it does not contain is marked as unrecognised. Typing something that is
 * not in the list still works — a model the console has not catalogued yet is a
 * legitimate thing to name — but it is said out loud rather than assumed right.
 */

/** How many suggestions the dropdown shows at once. */
const MAX_SUGGESTIONS = 8;

export interface ChipListProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly error?: ReactNode;
  readonly placeholder: string;
  readonly values: readonly string[];
  /** The half-typed name, held by the form so it survives a submit. */
  readonly text: string;
  readonly onTextChange: (value: string) => void;
  /** Adds every complete name in `raw`; the caller decides what a duplicate means. */
  readonly onAdd: (raw: string) => void;
  readonly onRemove: (token: string) => void;
  readonly mono?: boolean;
  /**
   * The names this field knows about, from the console's own data. Providing
   * them turns the field into a combobox; omitting them leaves it a plain chip
   * list with nothing to offer or to check against.
   */
  readonly suggestions?: readonly string[];
  /** True while that vocabulary is still being fetched, so nothing reads as unknown yet. */
  readonly suggestionsLoading?: boolean;
  /** Appended to an unrecognised name's tooltip, saying why it is worth a look. */
  readonly unknownHint?: string;
}

/**
 * Splits what is in the field into the part that is finished and the part still
 * being typed. A separator anywhere finishes everything before it, so pasting
 * `a, b, c` commits all three, while `a, b` with no trailing separator keeps the
 * `b` in the field in case it is only half a name.
 */
function splitTyped(raw: string): { readonly ready: string; readonly rest: string } {
  const trailing = /[\s,]+$/.test(raw);
  const lastSeparator = Math.max(raw.lastIndexOf(','), raw.lastIndexOf(' '));
  if (lastSeparator === -1) return { ready: '', rest: raw };
  if (trailing) return { ready: raw, rest: '' };
  return { ready: raw.slice(0, lastSeparator + 1), rest: raw.slice(lastSeparator + 1) };
}

export function ChipList({
  label,
  description,
  error,
  placeholder,
  values,
  text,
  onTextChange,
  onAdd,
  onRemove,
  mono = false,
  suggestions,
  suggestionsLoading = false,
  unknownHint,
}: ChipListProps) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const committed = new Set(values);
  const needle = text.trim().toLowerCase();
  const options =
    suggestions === undefined
      ? []
      : suggestions
          .filter(
            (name) => !committed.has(name) && (needle === '' || name.toLowerCase().includes(needle)),
          )
          .slice(0, MAX_SUGGESTIONS);

  // A field with nothing to offer never opens a dropdown, so an empty vocabulary
  // does not pop up a "no match" the operator cannot act on.
  const hasVocabulary = suggestions !== undefined && suggestions.length > 0;
  const open = hasVocabulary && focused && !dismissed;
  const showList = open && options.length > 0;
  // Read through a clamp rather than stored clamped, so a shrinking list cannot
  // leave the highlight pointing at a row that is no longer there.
  const active = options.length === 0 ? -1 : Math.min(activeIndex, options.length - 1);
  const optionId = (index: number) => `${baseId}-opt-${String(index)}`;

  const known = suggestions === undefined ? null : new Set(suggestions);
  const isUnknown = (token: string) =>
    known !== null && !suggestionsLoading && !known.has(token);
  const chipTitle = (token: string) => {
    if (unknownHint === undefined || !isUnknown(token)) return token;
    return `${token} — ${unknownHint}`;
  };

  const commit = (raw: string) => {
    const { ready, rest } = splitTyped(raw);
    if (ready !== '') onAdd(ready);
    onTextChange(rest);
  };

  const pick = (value: string) => {
    onAdd(value);
    onTextChange('');
    setActiveIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setDismissed(false);
        return;
      }
      if (options.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + step + options.length) % options.length);
      return;
    }
    if (event.key === 'Escape') {
      // Only when the dropdown is up: otherwise Escape belongs to the dialog.
      if (!open) return;
      event.preventDefault();
      setDismissed(true);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const choice = active === -1 ? undefined : options[active];
      if (choice !== undefined) {
        pick(choice);
        return;
      }
      if (text.trim() !== '') {
        onAdd(text);
        onTextChange('');
        setActiveIndex(0);
      }
      return;
    }
    if (event.key === 'Backspace' && text === '' && values.length > 0) {
      const last = values[values.length - 1];
      if (last !== undefined) onRemove(last);
    }
  };

  return (
    <Field label={label} description={description} error={error}>
      {({ id, describedBy }) => (
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Input
              id={id}
              aria-describedby={describedBy}
              role={suggestions === undefined ? undefined : 'combobox'}
              aria-expanded={suggestions === undefined ? undefined : showList}
              aria-controls={showList ? listId : undefined}
              aria-activedescendant={showList ? optionId(active) : undefined}
              aria-autocomplete={suggestions === undefined ? undefined : 'list'}
              value={text}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className={mono ? 'font-mono' : undefined}
              onChange={(event) => {
                setDismissed(false);
                setActiveIndex(0);
                commit(event.target.value);
              }}
              onFocus={() => {
                setFocused(true);
                setDismissed(false);
              }}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                setFocused(false);
                setDismissed(false);
                if (text.trim() !== '') {
                  onAdd(text);
                  onTextChange('');
                }
              }}
            />
            {open ? (
              <SuggestionList
                id={listId}
                label={`${typeof label === 'string' ? label : 'Suggestions'} suggestions`}
                options={options}
                activeIndex={active}
                optionId={optionId}
                emptyText={
                  suggestionsLoading
                    ? 'Loading the list…'
                    : 'Nothing here matches. Enter still adds it as typed.'
                }
                onActiveIndexChange={setActiveIndex}
                onPick={pick}
              />
            ) : null}
          </div>
          {values.length === 0 ? null : (
            <ul className="flex flex-wrap gap-1.5">
              {values.map((token) => (
                <li key={token}>
                  <Badge
                    tone={isUnknown(token) ? 'warning' : 'neutral'}
                    size="md"
                    className="gap-1 pr-1 font-mono"
                    title={chipTitle(token)}
                  >
                    <span className="max-w-[16rem] truncate">{token}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${token}`}
                      className="rounded-key p-0.5 text-text-subtle transition-colors duration-(--dur-micro) ease-out outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-focus"
                      onClick={() => {
                        onRemove(token);
                      }}
                    >
                      <X aria-hidden="true" className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Field>
  );
}
