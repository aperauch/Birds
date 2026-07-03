import { defineConfig } from "vitest/config";

// Unit tests cover the pure helpers only (tz, sun) — plain node environment, no
// workers runtime needed. Endpoint behaviour is covered by the web/ Playwright
// smoke suite running against `wrangler dev`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
