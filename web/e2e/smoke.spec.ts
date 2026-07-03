import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import { BASE_URL, INGEST_TOKEN, SPECIES, seedDetections } from "./fixtures.mjs";

// Smallest valid 1x1 transparent PNG, so the modal's <img> actually renders
// without a browser decode error (the mp3 bytes below don't need to be this
// careful since we never assert on successful audio decode).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function ingest(
  ctx: APIRequestContext,
  meta: Record<string, unknown>,
  files?: { clip?: Buffer; spectrogram?: Buffer },
): Promise<void> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    meta: JSON.stringify(meta),
  };
  if (files?.clip) multipart.clip = { name: "clip.mp3", mimeType: "audio/mpeg", buffer: files.clip };
  if (files?.spectrogram) {
    multipart.spectrogram = { name: "s.png", mimeType: "image/png", buffer: files.spectrogram };
  }
  const res = await ctx.post("/ingest", {
    headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    multipart,
  });
  if (!res.ok()) throw new Error(`ingest failed: ${res.status()} ${await res.text()}`);
}

// Seed through the real ingest path (idempotent — deterministic ids).
test.beforeAll(async () => {
  const ctx = await pwRequest.newContext({ baseURL: BASE_URL });
  const nowS = Math.floor(Date.now() / 1000);
  for (const meta of seedDetections(nowS)) await ingest(ctx, meta);
  // One detection carries a clip so the modal renders a Play button. The bytes
  // only need to look like an MPEG frame — the smoke test checks the player UI
  // wiring, not that the audio actually decodes.
  // Both sit before the Mourning Dove (the newest seeded detection, at -4m) so
  // they don't change which chip the live-ticker test expects to see first.
  // One has only a clip (exercises the synthetic-waveform fallback), the
  // other has both a clip and a spectrogram (exercises the real-spectrogram
  // + progress-cursor path) — together they cover both branches in one modal.
  await ingest(
    ctx,
    {
      id: "e2e-clip-0001",
      ts: nowS - 5 * 60,
      sci_name: "Cardinalis cardinalis",
      com_name: "Northern Cardinal",
      confidence: 0.97,
      sensor_id: "e2e",
    },
    { clip: Buffer.from([0xff, 0xfb, 0x90, 0x00]) },
  );
  await ingest(
    ctx,
    {
      id: "e2e-clip-0002",
      ts: nowS - 6 * 60,
      sci_name: "Cardinalis cardinalis",
      com_name: "Northern Cardinal",
      confidence: 0.92,
      sensor_id: "e2e",
    },
    { clip: Buffer.from([0xff, 0xfb, 0x90, 0x00]), spectrogram: TINY_PNG },
  );
  await ctx.dispose();
});

test("collage renders a tile per seeded species with live counts", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tile")).toHaveCount(SPECIES.length);
  await expect(page.locator("#species-count")).toHaveText(`${SPECIES.length} species`);
  await expect(page.locator("#detection-count")).toHaveText("12 calls"); // 10 seeded + 2 with a clip
});

test("cards and list views render every species", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Cards", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(SPECIES.length);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(SPECIES.length);
});

test("clicking a tile opens the species modal, Escape closes it", async ({ page }) => {
  await page.goto("/");
  await page.locator('.tile[data-sci="Cardinalis cardinalis"]').click();
  const modal = page.locator("#modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator("h2")).toHaveText("Northern Cardinal");
  await expect(modal.locator(".meta")).toBeVisible(); // detail fetch landed
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
});

test("a recording's play button opens the docked mini-player", async ({ page }) => {
  await page.goto("/");
  await page.locator('.tile[data-sci="Cardinalis cardinalis"]').click();
  const modal = page.locator("#modal");
  await expect(modal).toBeVisible();
  const playBtn = modal.locator(".play-btn").first();
  await expect(playBtn).toBeVisible();
  await playBtn.click();
  const player = page.locator("#player");
  await expect(player).toBeVisible();
  await expect(player.locator(".player-title")).toContainText("Northern Cardinal");
  // Closing the modal must not stop playback — the whole point of a docked player.
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(player).toBeVisible();
});

test("spectrogram and waveform recordings both render in the species modal", async ({ page }) => {
  await page.goto("/");
  await page.locator('.tile[data-sci="Cardinalis cardinalis"]').click();
  const modal = page.locator("#modal");
  await expect(modal).toBeVisible();
  // One seeded recording has a spectrogram (real PNG + cursor), the other only
  // a clip (falls back to the synthetic canvas waveform).
  await expect(modal.locator(".spectro")).toHaveCount(1);
  await expect(modal.locator(".spectro img")).toBeVisible();
  await expect(modal.locator(".spectro-cursor")).toHaveCount(1);
  await expect(modal.locator("canvas.wave")).toHaveCount(1);
});

test("species modal shows 30-day and hourly mini-charts", async ({ page }) => {
  await page.goto("/");
  await page.locator('.tile[data-sci="Cardinalis cardinalis"]').click();
  const modal = page.locator("#modal");
  await expect(modal).toBeVisible();
  const charts = modal.locator(".species-chart");
  await expect(charts).toHaveCount(2);
  // All seeded Cardinal calls happened today, so both charts have real data
  // (not the "no calls"/"no activity" empty state).
  await expect(charts.nth(0).locator("svg.chart")).toBeVisible();
  await expect(charts.nth(1).locator("svg.chart")).toBeVisible();
  await expect(charts.nth(0).locator(".loading")).toHaveCount(0);
  await expect(charts.nth(1).locator(".loading")).toHaveCount(0);
});

test("day explorer groups today's seeded detections by hour", async ({ page }) => {
  await page.goto("/#/day");
  await expect(page.locator(".day-view")).toBeVisible();
  // All fixture detections are timestamped "now minus a few minutes", so
  // they all land in today's Eastern date and the view must not be empty.
  await expect(page.locator(".day-hour")).not.toHaveCount(0);
  await expect(page.locator(".day-row")).not.toHaveCount(0);
  await expect(page.locator(".day-strip .day-bar:not([disabled])")).not.toHaveCount(0);

  // Clicking a species name in the day view opens its modal (same route as
  // everywhere else in the app).
  await page.locator(".day-sp").first().click();
  await expect(page.locator("#modal")).toBeVisible();
  await page.keyboard.press("Escape");

  // Next day is always "the future" relative to the fixture data, so it must
  // be disabled — the day explorer never lets you browse ahead of today.
  await expect(page.locator(".day-nav.next")).toBeDisabled();
});

test("trends route renders the analytics cards", async ({ page }) => {
  await page.goto("/#/trends");
  await expect(page.locator(".trend-card")).not.toHaveCount(0);
  await expect(page.locator(".trend-card h3", { hasText: "Overview" })).toBeVisible();
  await expect(
    page.locator(".trend-card h3", { hasText: "Detections per day" }),
  ).toBeVisible();
  // Every seeded call happened today, so the daily line chart has data.
  await expect(page.locator(".trend-grid svg.chart").first()).toBeVisible();

  // Phase 3a client-side analytics cards.
  await expect(page.locator(".trend-card h3", { hasText: "Records & streaks" })).toBeVisible();
  await expect(page.locator(".trend-card h3", { hasText: "This week vs last week" })).toBeVisible();
  // Fixture data spans under 14 days, so the week-over-week comparison should
  // show its "needs more history" empty state rather than a misleading 0%.
  await expect(page.locator(".trend-card", { hasText: "This week vs last week" })).toContainText(
    "Needs two weeks",
  );
  const sparkCard = page.locator(".trend-card", { hasText: "Species trends" });
  await expect(sparkCard).toBeVisible();
  await expect(sparkCard.locator(".spark-row")).not.toHaveCount(0);
  await expect(
    page.locator(".trend-card h3", { hasText: "Species diversity" }),
  ).toBeVisible();

  // Phase 3b server-side analytics cards.
  const punchCard = page.locator(".trend-card", { hasText: "Weekly punchcard" });
  await expect(punchCard).toBeVisible();
  await expect(punchCard.locator(".punch-cell i")).not.toHaveCount(0);
  const dawnCard = page.locator(".trend-card", { hasText: "Dawn chorus" });
  await expect(dawnCard).toBeVisible();
  await expect(dawnCard.locator("svg.chart circle")).not.toHaveCount(0);
});

test("a live ingest reaches the ticker over the WebSocket", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tile")).toHaveCount(SPECIES.length);
  const newest = page.locator("#ticker .chip.newest");
  await expect(newest).toContainText("Mourning Dove"); // newest seeded detection

  const ctx = await pwRequest.newContext({ baseURL: BASE_URL });
  await ingest(ctx, {
    id: `e2e-live-${Date.now()}`,
    ts: Math.floor(Date.now() / 1000),
    sci_name: "Cyanocitta cristata",
    com_name: "Blue Jay",
    confidence: 0.85,
    sensor_id: "e2e",
  });
  await ctx.dispose();

  // Delivered via ingest -> D1 -> Aviary DO -> /ws -> ticker.
  await expect(newest).toContainText("Blue Jay", { timeout: 10_000 });
});
