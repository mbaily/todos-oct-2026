import { defineConfig } from '@playwright/test';

const basePath = process.env.TEST_BASE_PATH ?? '/';
const baseURL = 'http://127.0.0.1:3100' + basePath;

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  use: { baseURL, headless: true },
  webServer: {
    command: basePath === '/' ? 'node server.js' : 'node test/subpath-server.js',
    url: baseURL,
    env: { HOST: '127.0.0.1', PORT: '3100', DB_PATH: ':memory:', TEST_BASE_PATH: basePath },
    reuseExistingServer: false,
  },
});
