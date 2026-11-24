import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tests run behind UTC, so a date shown in UTC instead of the user's time zone is hours or a day
// off and fails a test (a Round's start, a due date); their late-November dates are UTC−8. Set
// here, before any worker starts: assigning TZ inside a worker thread (Stryker's runner) doesn't
// change the process's time zone, and `test.env` is applied too late for it.
if (process.env.VITEST) process.env.TZ = 'America/Los_Angeles';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `vite preview` uses the same proxy. The browser tests point it at their own API (ADR-0065).
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:3001' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // The browser tests run under Playwright (`pnpm test:browser`), not Vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    // Vitest replaces CSS with stubs; let `?raw` imports through, so a test can read a stylesheet.
    css: { include: [/\.css\?raw$/] },
  },
});
