import { defineConfig, devices } from '@playwright/test';

// E2E runs against the production build served by `vite preview`. Locally, set
// PW_CHROMIUM to the pre-installed Chromium binary; in CI, `playwright install
// chromium` provides a matching browser and PW_CHROMIUM is left unset.
const executablePath = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    ...(executablePath ? { launchOptions: { executablePath, args: ['--no-sandbox'] } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
