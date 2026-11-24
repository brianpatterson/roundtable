import path from 'node:path';

/**
 * Everything a run writes: report, traces, screenshots, the API's log. Git-ignored. Not a hidden
 * folder: CI's upload-artifact skips those, and uploaded nothing from `e2e/.output/`.
 */
export const OUTPUT_DIR = path.join(import.meta.dirname, '..', 'test-results');

/** The browser tests' API writes its log here (playwright.config.ts). */
export const API_LOG = path.join(OUTPUT_DIR, 'api.log');

/** The signed-in user's cookies, saved by `auth.setup.ts` for every other test. */
export const AUTH_STATE = path.join(OUTPUT_DIR, 'auth.json');

/** Screenshots for the reviewer (ADR-0065), uploaded as a CI artifact. */
export const SCREENSHOTS_DIR = path.join(OUTPUT_DIR, 'screenshots');
