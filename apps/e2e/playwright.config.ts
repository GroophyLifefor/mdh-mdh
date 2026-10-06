import { defineConfig, devices } from '@playwright/test';

// Tests run against the REAL production setup: the Express server serving the built website (with its CSP),
// talking to a throw-away PostgreSQL 18. See global-setup.ts.
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  fullyParallel: true,
  workers: 3,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1300, height: 800 },
  },
  projects: [
    { name: 'chromium', testIgnore: /mobile\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1300, height: 800 } } },
    // a phone: narrow screen, touch, no hover. Same Chromium engine; real Safari/iOS is not part of this suite.
    { name: 'phone', testMatch: /mobile\.spec\.ts/, use: { ...devices['Pixel 7'] } },
  ],
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
});
