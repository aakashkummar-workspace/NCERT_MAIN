import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import "dotenv/config";
import { assertLocalDatabase } from "./scripts/lib/local-database.mjs";

assertLocalDatabase("The browser test suite");

/**
 * End-to-end and accessibility tests.
 *
 * ---------------------------------------------------------------------------
 * What belongs here, and what does not
 * ---------------------------------------------------------------------------
 * There are already 766 smoke checks driving the real HTTP API against a real
 * build. Re-proving status codes and payload shapes in a browser would double
 * the runtime and the maintenance for nothing.
 *
 * So this suite covers only what a browser can prove and HTTP cannot:
 *
 *   - work surviving a refresh, a dropped connection, a backgrounded tab
 *   - keyboard operation and visible focus
 *   - axe violations on rendered pages
 *   - tap targets and layout at 360px
 *
 * TESTING.md §4 names the thirteen flows; §7 names the design QA. Both are the
 * settled spec, and this suite is measured against them.
 *
 * ---------------------------------------------------------------------------
 * One worker, on purpose
 * ---------------------------------------------------------------------------
 * Every spec builds its own organisation against one shared Postgres. Parallel
 * workers contend on it — the integration suite already hits transaction
 * timeouts under load — and a flaky suite is one people learn to re-run rather
 * than read. Correctness first; this is not the suite that has to be fast.
 */
const PORT = 3210;
const BASE = process.env.BASE ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // A student flow waits on real timers (autosave, the heartbeat), so the
  // default five seconds is not enough to be meaningful here.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  /**
   * Artifacts go OUTSIDE the repository, under a per-run directory.
   *
   * Two separate problems, one fix. Sibling Playwright runs share
   * `test-results/` by default and delete each other's traces mid-run, which
   * stalled two runs outright. And on this Windows filesystem the artifact
   * cleanup races itself even in a single run: roughly one test in eight dies
   * at teardown with ENOENT on a trace file, with no assertion having failed.
   *
   * Reproduced against the repo's own probe spec at `--repeat-each 8`, so it is
   * the tooling rather than any one test.
   */
  outputDir: join(tmpdir(), "sahayak-e2e", String(process.pid)),

  use: {
    baseURL: BASE,
    // Off by default, because the cleanup race above is triggered by tracing
    // and a green local run does not need it. CI keeps it for the retry, where
    // it is the only way to see what happened on a machine nobody is sitting
    // at.
    trace: process.env.CI ? "on-first-retry" : "off",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      // 390px is the width the design system is checked at, and the one a
      // student is actually holding.
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
      testMatch: /(responsive|a11y)\.spec\.ts/,
    },
  ],

  // Reuses a server that is already up rather than fighting it for the port —
  // a zombie `next start` holding 3210 once produced three confident,
  // fictitious failures.
  webServer: {
    command: "npm start",
    url: `${BASE}/signin/`,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
