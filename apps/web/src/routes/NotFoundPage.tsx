import { Link } from 'react-router';

import { StateView } from '@web/components/ui/StateView.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';

/** Inside the shell, so a mistyped URL leaves the navigation usable. */
export function NotFoundPage() {
  return (
    <div className="flex min-h-full items-center justify-center p-5">
      <StateView
        kind="no-results"
        title="Page not found"
        description="That route does not exist in rutekit. It may have been renamed, or the link may be wrong."
        action={
          <Link to="/" className={buttonVariants({ variant: 'primary', size: 'md' })}>
            Back to dashboard
          </Link>
        }
      />
    </div>
  );
}
