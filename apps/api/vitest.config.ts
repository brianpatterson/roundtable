import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
    // Creates a Stryker worker's own test database; does nothing otherwise.
    globalSetup: ['./test/test-database.ts'],
  },
});
