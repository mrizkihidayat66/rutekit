import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy } from 'react';
import { BrowserRouter } from 'react-router';

import { ErrorBoundary } from '@web/components/ErrorBoundary.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { TooltipProvider } from '@web/components/ui/Tooltip.tsx';
import { queryClient } from '@web/lib/query-client.ts';
import { mocksEnabled } from '@web/mocks/mock-mode.ts';
import { AppRoutes } from '@web/routes/route-table.tsx';
import { AppearanceLayer } from '@web/shell/AppearanceLayer.tsx';

/**
 * Dev-only, and only while the mock layer is on.
 *
 * Every control on it belongs to the mocks: the four response states set a
 * latency/failure mode that only mocked requests pass through, and the three auth
 * buttons write the in-memory mock database. With mocks off — which is now the
 * default — it would be a panel of buttons that do nothing, which is worse than
 * no panel.
 *
 * Compiled away in a production build either way: the condition is a static
 * `import.meta.env.DEV`, so the chunk is never requested and never emitted.
 */
const MockFlipper =
  import.meta.env.DEV && mocksEnabled
    ? lazy(() =>
        import('@web/dev/MockFlipper.tsx').then((module) => ({ default: module.MockFlipper })),
      )
    : null;

/**
 * Composition root. The outermost boundary catches a crash in the shell itself
 * — the per-route boundary inside `AppShell` handles page-level failures — and
 * the Suspense here only ever covers the eagerly-imported shell plus the
 * standalone showcase route.
 *
 * `AppearanceLayer` sits above the router on purpose: it paints what is behind
 * every route, including the standalone showcase, and it must not unmount when
 * a page-level boundary catches an error.
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250}>
        <AppearanceLayer />
        <BrowserRouter>
          <ErrorBoundary>
            <Suspense fallback={<StateView kind="loading" className="h-dvh" />}>
              <AppRoutes />
            </Suspense>
            {MockFlipper === null ? null : (
              <Suspense fallback={null}>
                <MockFlipper />
              </Suspense>
            )}
          </ErrorBoundary>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
