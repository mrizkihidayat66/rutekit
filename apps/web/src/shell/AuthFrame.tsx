import type { ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

/**
 * The frame the two ways into the console share.
 *
 * Both pages sit outside the shell, and they have to: there is no rail worth
 * showing before you are inside, and one that listed pages which all bounce
 * straight back here would be a menu of dead ends. So this is the entire page —
 * the instance's own background, painted by `AppearanceLayer` above the router,
 * with a single card centred on it.
 *
 * It is also what `AuthGate` puts its own loading and error states in, so a
 * visitor who arrives while the auth record is still in flight sees the same
 * page they are about to land on rather than an unrelated full-screen spinner.
 */
export function AuthFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-5">
      <div className={cn('w-full max-w-md', className)}>{children}</div>
    </div>
  );
}
