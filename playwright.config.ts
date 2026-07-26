import { defineConfig } from "@playwright/test";

// End-to-end tests for the spell crafter (/editor). Uses the installed
// Google Chrome (channel) so no browser download is needed, and reuses a
// running dev server when there is one.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1400, height: 900 },
  },
  projects: [
    {
      name: "chrome",
      use: { channel: "chrome" },
    },
    {
      // The user runs Safari; on macOS Playwright's WebKit uses Apple's
      // real media frameworks, so the playback-clock and transport
      // behavior tests also run where the field bugs actually live.
      name: "webkit-media",
      use: { browserName: "webkit" },
      testMatch: /playhead\.spec\.ts|song\.spec\.ts/,
    },
  ],
  webServer: {
    command: "yarn dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
