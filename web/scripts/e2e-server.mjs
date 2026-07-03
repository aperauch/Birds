// Playwright webServer command: builds the SPA, prepares a fresh local D1 state,
// pre-inserts the fixture species (so seeded detections are never "new species"
// and no art jobs — which would call Workers AI — are enqueued), then runs the
// real edge Worker via `wrangler dev --local` on :8788 serving web/dist.
//
// Set E2E_SKIP_BUILD=1 to reuse the current web/dist while iterating on specs.
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INGEST_TOKEN, SPECIES } from "../e2e/fixtures.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edgeDir = path.resolve(webDir, "..", "edge");
const PERSIST = ".wrangler/e2e-state"; // relative to edgeDir (cwd of all wrangler calls)
const PORT = "8788";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[e2e-server] failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

if (!process.env.E2E_SKIP_BUILD) {
  run("npm", ["run", "build"], webDir);
}

// Fresh local state every run so specs are deterministic.
rmSync(path.join(edgeDir, PERSIST), { recursive: true, force: true });
run(
  "npx",
  ["wrangler", "d1", "migrations", "apply", "birds", "--local", "--persist-to", PERSIST],
  edgeDir,
);

const speciesValues = SPECIES.map(
  (s) => `('${s.sci}', '${s.com}', unixepoch()-604800, unixepoch()-604800, 0, 0.5)`,
).join(", ");
run(
  "npx",
  [
    "wrangler", "d1", "execute", "birds", "--local", "--persist-to", PERSIST,
    "--command",
    `INSERT INTO species (sci_name, com_name, first_seen, last_seen, total_count, best_confidence) VALUES ${speciesValues};`,
  ],
  edgeDir,
);

// --local disables remote bindings (AI/browser) outright — belt and braces.
const child = spawn(
  "npx",
  [
    "wrangler", "dev", "--local",
    "--port", PORT,
    "--persist-to", PERSIST,
    "--var", `INGEST_TOKEN:${INGEST_TOKEN}`,
  ],
  { cwd: edgeDir, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill("SIGTERM"));
}
