import { defineConfig } from "vitest/config";

// Unit tests cover the pure modules (format/color/packing/analytics) — no DOM
// needed. The browser paths are covered by the Playwright smoke suite (e2e/).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
