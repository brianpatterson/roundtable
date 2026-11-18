import type { ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Unauthorized } from '@roundtable/contract';
import { ApiError } from '@roundtable/contract/client';
import { SnackbarProvider, ThemeProvider } from '../design-system';
import { sessionEnded } from '../modules/identity';

/** The API no longer accepts the session. Identity handles it; no feature module does. */
const isUnauthorized = (error: Error) =>
  error instanceof ApiError && error.cause instanceof Unauthorized;

const reportUnauthorized = (error: Error) => {
  if (isUnauthorized(error)) sessionEnded();
};

/**
 * The server-state cache. Every query and mutation that fails with Unauthorized goes to identity's
 * `sessionEnded`, which returns the user to sign-in (session expiry, see docs/architecture.md).
 */
export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reportUnauthorized }),
    mutationCache: new MutationCache({ onError: reportUnauthorized }),
    defaultOptions: {
      // Asking again won't bring the session back: go to sign-in now, not after three retries.
      queries: { retry: (failures, error) => !isUnauthorized(error) && failures < 3 },
    },
  });
}

const appQueryClient = createQueryClient();

/** App-wide providers every module relies on: the theme, snackbars and server-state cache. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <SnackbarProvider>
        <QueryClientProvider client={appQueryClient}>{children}</QueryClientProvider>
      </SnackbarProvider>
    </ThemeProvider>
  );
}
