import { defineConfig } from "@playwright/test";

// End-to-end tests for the spell crafter (/editor). Uses the installed
// Google Chrome (channel) so no browser download is needed, and reuses a
// running dev server when there is one.
//
// PORT overrides which one. That matters when this checkout is a worktree:
// `reuseExistingServer` will happily adopt a dev server that ANOTHER checkout
// left on 3000, and then the whole suite passes against code you did not
// write. Run `PORT=3100 corepack yarn playwright test` from a worktree, or
// stop the other server first.
const port = process.env.PORT ?? "3000";
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // Files run in parallel, tests within a file stay in order. Measured on the
  // full suite: 6.3 min at 1 worker, 3.7 at 2, 2.9 at 4 — but 4 put enough CPU
  // contention on the pointer-timing tests to make a drag test flake 1 run in
  // 3. Two takes 41% off the wall clock and left them alone, which is the
  // trade worth making: a flaky suite costs more than the 48 seconds.
  fullyParallel: false,
  workers: 2,
  retries: 1,
  reporter: [["list"]],
  // Each test creates its own experience row; this removes them afterwards so
  // they stop accumulating in the editor's Open menu.
  globalTeardown: "./e2e/globalTeardown.ts",
  use: {
    baseURL,
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
    // 127.0.0.1 only, never all interfaces.
    command: `yarn dev -H 127.0.0.1 -p ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
