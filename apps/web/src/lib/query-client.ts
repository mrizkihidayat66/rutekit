import { QueryClient } from '@tanstack/react-query';

/**
 * One client for the whole app. Defaults are tuned for a local, single-user
 * dashboard: data is cheap to refetch but the socket pushes most updates, so
 * aggressive polling would only add noise.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
