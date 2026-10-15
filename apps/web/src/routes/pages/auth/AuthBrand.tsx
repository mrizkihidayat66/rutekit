import { Route } from 'lucide-react';

import { useBranding } from '@web/hooks/use-system.ts';
import { cn } from '@web/lib/cn.ts';

/**
 * The same mark the rail carries, so the page a visitor signs in on belongs to
 * the instance they are signing into rather than to a generic form.
 *
 * It reads the same two records the rail does, which means a background or icon
 * set in Customization is already on screen the first time the login page is
 * opened after a reload — the branding is not something the console keeps to
 * itself once you are inside it.
 */
export function AuthBrand() {
  const branding = useBranding();

  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <span
        className={cn(
          'flex size-11 items-center justify-center overflow-hidden rounded-card',
          branding.iconUrl === null && 'bg-accent text-accent-contrast',
        )}
      >
        {branding.iconUrl === null ? (
          <Route className="size-5" aria-hidden="true" />
        ) : (
          <img src={branding.iconUrl} alt="" className="size-full object-contain" />
        )}
      </span>
      <span className="font-head text-sm font-semibold tracking-tight text-text">
        {branding.name}
      </span>
    </div>
  );
}
