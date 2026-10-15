import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useUpdateCustomization } from '@web/hooks/use-system.ts';
import { cn } from '@web/lib/cn.ts';
import {
  applyTheme,
  readThemePreference,
  watchThemePreference,
  type ThemePreference,
} from '@web/lib/theme.ts';

const OPTIONS: Array<{ value: ThemePreference; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

/**
 * Three-way theme switch. The flip is animated because the palette transition
 * lives on `body` under `html.theme-ready` (PRD §7.2 rule 6).
 *
 * The theme is stored twice on purpose, and the two stores are written together
 * here rather than by whoever happens to be rendering the control. `localStorage`
 * is what the pre-paint script in `index.html` reads, so the first frame is
 * already the right palette and there is no flash on reload; the appearance
 * record is the server's copy, which is what a backup carries and what the
 * Customization page reads. Writing only one of them is how the two come to
 * disagree.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  const update = useUpdateCustomization();

  // The command palette can flip the theme too; follow whatever changed it.
  useEffect(() => watchThemePreference(setPreference), []);

  const select = (value: ThemePreference): void => {
    setPreference(value);
    applyTheme(value);
    update.mutate({ theme: value });
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-control border border-border bg-surface-2 p-0.5',
        className,
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => select(value)}
            className={cn(
              'flex size-7 items-center justify-center rounded-control transition duration-(--dur-micro) ease-out',
              active
                ? 'bg-surface-3 text-text shadow-card'
                : 'text-text-subtle hover:text-text',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
