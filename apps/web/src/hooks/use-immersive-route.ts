import { useEffect } from 'react';

import { setImmersive } from '@web/shell/immersive.ts';

/**
 * Ask the shell to hide its status bar for as long as this route is mounted.
 *
 * A page calls this with no arguments; a page that only wants the space under
 * some condition passes the condition and the bar comes back when it goes false.
 * The cleanup always clears the flag, so navigating away restores the bar
 * whatever happened in between.
 */
export function useImmersiveRoute(immersive = true): void {
  useEffect(() => {
    if (!immersive) return undefined;
    setImmersive(true);
    return () => {
      setImmersive(false);
    };
  }, [immersive]);
}
