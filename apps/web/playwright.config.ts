import { defineConfig, devices } from "@playwright/test";

// E2E against a running stack (`make dev` locally; the k3d stack in CI from M5).
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: process.env.E2E_BROWSER ?? "chromium", use: { ...devices[process.env.E2E_BROWSER === "firefox" ? "Desktop Firefox" : "Desktop Chrome"] } }],
});
