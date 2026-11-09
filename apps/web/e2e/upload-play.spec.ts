// Upload -> pipeline -> READY -> plays. Needs the dev stack and `make media`.
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const media = (f: string) => resolve(__dirname, "../../../media", f);

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.SEED_USER_EMAIL ?? "demo@streamforge.local");
  await page.getByLabel("Password").fill(process.env.SEED_USER_PASSWORD ?? "demo-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
}

async function uploadAndOpen(page: Page, file: string) {
  const created = page.waitForResponse((r) => r.url().endsWith("/videos") && r.request().method() === "POST" && r.status() === 201);
  await page.getByTestId("file-input").setInputFiles(media(file));
  const { video } = await (await created).json();
  await expect(page.getByText("Uploaded · processing…")).toBeVisible({ timeout: 60_000 });
  await page.locator(`[data-video-id="${video.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/videos/${video.id}$`));
  return video.id as string;
}

test("upload a clip, watch it process, and play it", async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, "clip-360p-10s.mp4");

  // live pipeline: every stage completes and the player appears
  const player = page.getByTestId("player-video");
  await expect(player).toBeVisible({ timeout: 120_000 });
  for (const stage of ["uploaded", "probe", "transcode", "thumbnail", "ready"]) {
    await expect(page.locator(`[data-stage="${stage}"]`)).toHaveAttribute("data-state", "done");
  }
  await expect(page.getByTestId("quality-menu")).toBeVisible();

  // it actually plays (muted so autoplay policy allows it)
  await player.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(1);

  // scrub preview shows a sprite tile
  const bar = page.getByTestId("seek-bar");
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect(page.getByTestId("scrub-preview")).toBeVisible();
});

test("a corrupt upload ends FAILED with a readable reason", async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, "corrupt.mp4");
  await expect(page.getByTestId("failure-reason")).toHaveText("The file is not a readable video", { timeout: 60_000 });
});
