import { useId, type ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

export interface FieldProps {
  label: ReactNode;
  /** A single control, or a render function receiving the generated ids. */
  children: ReactNode | ((ids: { id: string; describedBy: string | undefined }) => ReactNode);
  description?: ReactNode;
  /** Message shown below the control; implies `invalid` on the control. */
  error?: ReactNode;
  required?: boolean;
  /** Right-aligned hint in the label row, e.g. a character count. */
  hint?: ReactNode;
  className?: string;
}

/**
 * Label + control + description + error, with the ARIA wiring done once.
 * The control is passed a render function so it can adopt the generated ids
 * rather than every call site inventing its own.
 */
export function Field({
  label,
  children,
  description,
  error,
  required = false,
  hint,
  className,
}: FieldProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium text-text-muted">
          {label}
          {required ? (
            <span className="ml-0.5 text-danger-text" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
        {hint ? <span className="text-[0.6875rem] text-text-subtle tabular-nums">{hint}</span> : null}
      </div>

      {typeof children === 'function' ? children({ id, describedBy }) : children}

      {description && !error ? (
        <p id={descriptionId} className="text-[0.6875rem] text-text-subtle">
          {description}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="text-[0.6875rem] text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
