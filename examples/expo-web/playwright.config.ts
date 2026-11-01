import { defineConfig, devices } from '@playwright/test';

// Serves the static web build that `npm run build:web` writes to dist/.
const PORT = 8081;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  reporter: [['list'], ['@testivai/witness-playwright/reporter']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // TestivAI's stabilization freezes CSS animations, not JS-driven ones;
    // reduced motion asks the app to skip those.
    reducedMotion: 'reduce',
  },
  webServer: {
    command: `npx expo serve --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
  // Two projects, so snapshots are keyed orders__pixel-7 and orders__iphone-13.
  projects: [
    { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
    { name: 'iphone-13', use: { ...devices['iPhone 13'] } },
  ],
});
