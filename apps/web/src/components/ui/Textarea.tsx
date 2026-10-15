import type { ComponentPropsWithRef } from 'react';

import { cn } from '@web/lib/cn.ts';

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  invalid?: boolean;
  /** Grows with content instead of scrolling. Used by the chat composer. */
  autoGrow?: boolean;
}

export function Textarea({ invalid = false, autoGrow = false, className, ...props }: TextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full rounded-control border bg-surface-2 px-3 py-2 text-sm text-text',
        'placeholder:text-text-subtle transition duration-(--dur-micro) ease-out outline-none',
        'hover:border-border-strong focus:border-border-strong focus:bg-surface-3',
        'disabled:cursor-not-allowed disabled:opacity-55',
        'scrollbar-none resize-none',
        invalid ? 'border-danger/60 focus:border-danger' : 'border-border',
        autoGrow ? 'field-sizing-content max-h-48' : 'min-h-20',
        className,
      )}
      {...props}
    />
  );
}
