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
    channel: "chrome",
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: "yarn dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
