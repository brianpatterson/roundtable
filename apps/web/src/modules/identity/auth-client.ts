import { createAuthClient } from 'better-auth/react';
import { recordRequest } from '../../shared/diagnostics';

// Same origin: Vite (dev) or the reverse proxy (prod) routes /api/auth/* to the API. Each call is
// noted for problem reports (ADR-0041): a failed sign-in is a common one. Through a hook rather
// than a fetch of ours, so the client keeps using the fetch it was created with.
export const authClient = createAuthClient({
  fetchOptions: {
    onResponse: ({ request, response }) => {
      recordRequest(request.method, request.url, response.status);
    },
  },
});
