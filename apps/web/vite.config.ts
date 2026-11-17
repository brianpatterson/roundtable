import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Vitest replaces CSS with stubs; let `?raw` imports through, so a test can read a stylesheet.
    css: { include: [/\.css\?raw$/] },
  },
});
