import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the web build (ARCHITECTURE.md 8, D57, D60).
 *
 * They play the files that get deployed: `pnpm build:web` first, then this
 * serves dist/web statically, controller included. Every page is opened with
 * `?signal=local`, so phones and game shake hands inside the browser instead
 * of through the public signaling server, and nothing here depends on the
 * internet.
 *
 * Everything they write goes under dist/, so the ignores that already cover
 * build output (git, ESLint) cover the reports and screenshots too.
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'dist/e2e-results',
  fullyParallel: true,
  // Each worker is a browser rendering WebGL in software. On a 24-core machine
  // the default of half the cores ran twelve of them at once, and tests that
  // pass in 7 s alone timed out at 120 s fighting each other for the CPU.
  workers: 4,
  reporter: [['list'], ['html', { outputFolder: 'dist/e2e-report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:4173/',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      // Chrome hides local addresses behind mDNS names, which a headless
      // browser talking to itself cannot always resolve. The pages are on one
      // machine, so the plain address is all either side needs.
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    },
  },
  webServer: {
    command: 'pnpm preview:web',
    url: 'http://localhost:4173/',
    reuseExistingServer: true,
  },
});
