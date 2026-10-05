import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // CI runs every package's tests at once on a small runner; keep this suite from starving the API and infra hooks.
    maxWorkers: 2,
  },
});
