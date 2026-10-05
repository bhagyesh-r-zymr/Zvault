import { defineConfig, devices } from '@playwright/test';

// Locally you can point at a preinstalled Chromium: PW_CHROMIUM_PATH=/path/to/chrome
const executablePath = process.env.PW_CHROMIUM_PATH;
const launchOptions = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: '.',
  testMatch: ['site/**/*.spec.ts', 'share/**/*.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure', launchOptions },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
    {
      name: 'phone',
      // Pixel 7 is Chromium based, so no extra browser to install.
      use: { ...devices['Pixel 7'], launchOptions },
    },
  ],
  webServer: [
    {
      command: 'node scripts/static-server.mjs ../apps/site 4173',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: !process.env.CI,
    },
    {
      // The share page is built the way the demo builds it, then served under /share/.
      command:
        'pnpm --filter @zvault/share-web exec vite build --outDir ../../e2e/.share-dist/share --emptyOutDir && node scripts/static-server.mjs .share-dist 4174',
      url: 'http://127.0.0.1:4174/share/',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { VITE_API_URL: 'http://localhost:3000' },
    },
  ],
});
