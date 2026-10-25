import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  reporter: [['json', { outputFile: '../browser-e2e-result.json' }], ['line']],
  use: { baseURL: 'http://127.0.0.1:4179', trace: 'retain-on-failure' },
  webServer: {
    command:
      'cd .. && NODE_ENV=test ADMIN_API_KEY=playwright-admin-key-123 DATA_DIR=/tmp/orbit-playwright PUBLIC_BASE_URL=http://127.0.0.1:4179 PORT=4179 npm start',
    url: 'http://127.0.0.1:4179/admin/',
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
});
