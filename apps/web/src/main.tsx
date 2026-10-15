import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles/app.css';
import { mocksEnabled } from './mocks/mock-mode.ts';
import {
  applyTheme,
  enableThemeTransition,
  readThemePreference,
  watchSystemTheme,
} from './lib/theme.ts';

/**
 * The console's entry point.
 *
 * The only decision here is whether the mock layer starts. It does not by
 * default: the real server is what the console talks to, and `VITE_MOCKS=on` is
 * the opt-in escape hatch (see `mocks/mock-mode.ts`).
 */

applyTheme(readThemePreference());
// After the first frame, so the initial paint never animates from an unstyled palette.
enableThemeTransition();
// Keep following the OS while the preference is "system".
watchSystemTheme(() => {
  if (readThemePreference() === 'system') applyTheme('system');
});

async function bootstrap(): Promise<void> {
  // Imported dynamically, and only in development. A static import would put
  // MSW and the whole fixture set in the production bundle — it is the largest
  // thing in the app and none of it belongs there (NFR-9).
  if (mocksEnabled) {
    const { startMockWorker } = await import('./mocks/browser.ts');
    // Before the first render, so no page query can escape past the worker.
    await startMockWorker();
  }

  const container = document.getElementById('root');
  if (!container) throw new Error('rutekit: #root element is missing from index.html');

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
