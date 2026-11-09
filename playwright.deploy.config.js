// Playwright config for verifying the ACTUAL deployed site (nginx in Docker),
// not the python http.server development harness.
//
// No webServer block on purpose: the suite must run against whatever is
// deployed on SF_URL, so a broken deployment fails the suite.
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.SF_URL || "http://127.0.0.1:8081";

export default defineConfig({
  testDir: "./tests/deployed",
  timeout: 45_000,
  retries: 0,
  reporter: "list",
  globalSetup: "./tests/deployed/global-setup.mjs",
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  projects: [
    { name: "chromium-deployed", use: { ...devices["Desktop Chrome"] } }
  ]
});
