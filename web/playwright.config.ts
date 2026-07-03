import { defineConfig, devices } from "@playwright/test";

// Smoke suite against the REAL edge Worker: scripts/e2e-server.mjs builds the
// SPA, migrates + seeds a throwaway local D1, and runs `wrangler dev` on :8788.
// Specs then seed detections through the real POST /ingest path.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  workers: 1, // specs share one seeded worker instance
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8788",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:8788/healthz",
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
