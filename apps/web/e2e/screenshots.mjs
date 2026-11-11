// Captures README screenshots from the running k3d stack (`make up`) with headless Chromium.
// Usage (from apps/web): node e2e/screenshots.mjs [library] [player] [ops] [grafana]
// Output: docs/img/*.png
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const APP = process.env.E2E_BASE_URL ?? "http://streamforge.localhost";
const GRAFANA = process.env.GRAFANA_URL ?? "http://grafana.streamforge.localhost";
const out = resolve(import.meta.dirname, "../../../docs/img");
const shots = process.argv.slice(2).length ? process.argv.slice(2) : ["library", "player", "ops", "grafana"];
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
const page = await ctx.newPage();
const save = (name) => page.screenshot({ path: resolve(out, `${name}.png`) }).then(() => console.log(`saved docs/img/${name}.png`));

await page.goto(`${APP}/login`);
await page.getByLabel("Email").fill(process.env.SEED_USER_EMAIL ?? "demo@streamforge.local");
await page.getByLabel("Password").fill(process.env.SEED_USER_PASSWORD ?? "demo-password");
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByRole("heading", { name: "Library" }).waitFor();
await page.getByTestId("library-grid").waitFor();

if (shots.includes("library")) {
  await page.waitForTimeout(2500); // posters + live progress
  await save("library");
}
if (shots.includes("player")) {
  await page.locator('[data-testid="video-card"]:has([data-status="READY"])').first().click();
  const video = page.getByTestId("player-video");
  await video.waitFor({ timeout: 30_000 });
  await video.evaluate((v) => ((v.muted = true), v.play()));
  await page.waitForFunction(() => document.querySelector('[data-testid="player-video"]').currentTime > 2);
  const box = await page.getByTestId("seek-bar").boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2); // scrub preview
  await page.getByTestId("scrub-preview").waitFor();
  await save("player");
  await page.goto(APP);
}
if (shots.includes("ops")) {
  await page.goto(`${APP}/admin`);
  await page.getByTestId("queues-table").waitFor();
  await page.waitForTimeout(1500);
  await save("ops");
}
if (shots.includes("grafana")) {
  await page.setViewportSize({ width: 1600, height: 1250 });
  const range = process.env.GRAFANA_RANGE ?? "now-15m";
  await page.goto(`${GRAFANA}/d/streamforge-pipeline/streamforge-pipeline?orgId=1&from=${range}&to=now&var-namespace=streamforge&kiosk&refresh=`);
  await page.getByText("Queue depth vs worker replicas").waitFor({ timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(6000); // panels render after their queries return
  await save("grafana-pipeline");
}
await browser.close();
