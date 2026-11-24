import { defineConfig, devices } from '@playwright/test';
import { API_LOG, AUTH_STATE, OUTPUT_DIR } from './e2e/paths';

// Browser tests (ADR-0065): Playwright against the built web app and the real API, on ports of
// their own so they run beside `pnpm dev`. The API gets a fresh `app_browser` database each run.
// Run with `pnpm --filter @roundtable/web test:browser`; Postgres must be up (`pnpm db:up`).

const API_PORT = 3101;
const WEB_PORT = 4173;
const webUrl = `http://localhost:${WEB_PORT}`;
const apiUrl = `http://localhost:${API_PORT}`;

// The same server as the Vitest database, so CI's Postgres service and `pnpm db:up` both work.
const databaseUrl = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/app_test',
);

databaseUrl.pathname = '/app_browser';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  outputDir: `${OUTPUT_DIR}/results`,
  // Tests share one signed-in user and one database: one at a time keeps them independent of
  // order. There are few enough that this costs seconds.
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci
    ? [['github'], ['html', { open: 'never', outputFolder: `${OUTPUT_DIR}/report` }]]
    : [['list'], ['html', { open: 'never', outputFolder: `${OUTPUT_DIR}/report` }]],
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /\.setup\.ts$/ },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
      dependencies: ['setup'],
    },
    {
      // Chromium with a phone's viewport and touch, so CI installs one browser.
      name: 'phone',
      use: { ...devices['Pixel 7'], storageState: AUTH_STATE },
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      // Output goes to a file: the sign-up test reads the confirmation link from it.
      command: `mkdir -p "${OUTPUT_DIR}" && pnpm --filter @roundtable/api exec tsx test/browser-server.ts > "${API_LOG}" 2>&1`,
      url: `${apiUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL: databaseUrl.href,
        API_PORT: String(API_PORT),
        // A test value, used only by this throwaway server.
        BETTER_AUTH_SECRET: 'browser-tests-only-secret-0123456789abcdef',
        BETTER_AUTH_URL: webUrl,
        // Blank counts as unset (env.ts): no email is sent, nothing reaches Sentry or GitHub,
        // whatever the shell exports.
        RESEND_API_KEY: '',
        EMAIL_FROM: '',
        SENTRY_DSN: '',
        GITHUB_ISSUES_APP_ID: '',
        GITHUB_ISSUES_INSTALLATION_ID: '',
        GITHUB_ISSUES_PRIVATE_KEY: '',
        GITHUB_ISSUES_REPOSITORY: '',
        REPORTS_EMAIL: '',
        FACTORY_REPORTS_TOKEN: '',
        GITHUB_CLIENT_ID: '',
        GITHUB_CLIENT_SECRET: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
      },
    },
    {
      // The production build, served the way Caddy serves it, minus Caddy's headers.
      command: `pnpm exec vite build && pnpm exec vite preview --port ${WEB_PORT} --strictPort`,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { API_URL: apiUrl },
    },
  ],
});
