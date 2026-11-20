import { createAuthClient } from 'better-auth/react';
import { recordingFetch } from '../../shared/diagnostics';

// Same origin: Vite (dev) or the reverse proxy (prod) routes /api/auth/* to the API. Each call is
// noted for problem reports (ADR-0041), network failures included: a failed sign-in is a common
// one. Like Better Auth's own default, it wraps the fetch there is when the client is created.
export const authClient = createAuthClient({
  fetchOptions: { customFetchImpl: recordingFetch(fetch) },
});
