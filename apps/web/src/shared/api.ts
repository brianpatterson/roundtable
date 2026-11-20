import { makeApiClient } from '@roundtable/contract/client';
import { recordingFetch } from './diagnostics';

// The typed client from the contract (ADR-0022). Same origin: Vite proxies /api in dev, Caddy in
// production, so the session cookie goes with every call. Each call is noted for problem reports
// (ADR-0041).
export const api = makeApiClient({ baseUrl: window.location.origin, fetch: recordingFetch() });
