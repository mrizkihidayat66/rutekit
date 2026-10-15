import type { ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

/**
 * One labelled setting: a name, a sentence about what it does, and the control.
 *
 * The control is on the right rather than under the label, because these are all
 * single controls with short labels — a full-width select under a full-width
 * label makes four settings look like a form to fill in, when three of them are
 * switches and a dropdown. The label column carries the explanation, which is
 * the part that actually needs reading.
 */
export function SettingRow({
  label,
  description,
  control,
  className,
}: {
  label: string;
  description: ReactNode;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-medium text-text">{label}</span>
        <span className="text-[0.6875rem] text-text-subtle">{description}</span>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
