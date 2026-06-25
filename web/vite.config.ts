import { defineConfig } from "vite";

// During `npm run dev`, proxy API/WS/media to a locally running `wrangler dev`
// (edge/) on :8787 so the SPA works end-to-end without deploying.
const EDGE = "http://localhost:8787";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: EDGE, changeOrigin: true },
      "/media": { target: EDGE, changeOrigin: true },
      "/ingest": { target: EDGE, changeOrigin: true },
      "/ws": { target: EDGE, ws: true, changeOrigin: true },
    },
  },
});
