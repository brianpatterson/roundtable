import type { ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Unauthorized } from '@roundtable/contract';
import { ApiError } from '@roundtable/contract/client';
import { SnackbarProvider, ThemeProvider, createSnackbars, type Snackbars } from '../design-system';
import { sessionEnded } from '../modules/identity';

// What a module can say about its mutation, checked wherever `useMutation` takes `meta`.
declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** Show this mutation's errors in a snackbar. The shell decides which errors that means. */
      errorSnackbar?: boolean;
    };
  }
}

/** The API no longer accepts the session. Identity handles it; no feature module does. */
const isUnauthorized = (error: Error) =>
  error instanceof ApiError && error.cause instanceof Unauthorized;

const reportUnauthorized = (error: Error) => {
  if (isUnauthorized(error)) sessionEnded();
};

/**
 * The server-state cache. Every query and mutation that fails with Unauthorized goes to identity's
 * `sessionEnded`, which returns the user to sign-in (session expiry, see docs/architecture.md).
 * A mutation that opts in with `meta: { errorSnackbar: true }` shows any other error's message in
 * `snackbars`: an ended session is never the module's to report.
 */
export function createQueryClient(snackbars: Snackbars) {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reportUnauthorized }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (isUnauthorized(error)) sessionEnded();
        else if (mutation.meta?.errorSnackbar) snackbars.show(error.message);
      },
    }),
    defaultOptions: {
      // Asking again won't bring the session back: go to sign-in now, not after three retries.
      queries: { retry: (failures, error) => !isUnauthorized(error) && failures < 3 },
    },
  });
}

const appSnackbars = createSnackbars();

const appQueryClient = createQueryClient(appSnackbars);

/** App-wide providers every module relies on: the theme, snackbars and server-state cache. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <SnackbarProvider snackbars={appSnackbars}>
        <QueryClientProvider client={appQueryClient}>{children}</QueryClientProvider>
      </SnackbarProvider>
    </ThemeProvider>
  );
}
