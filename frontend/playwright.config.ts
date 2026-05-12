/**
 * Playwright config for the qmem-digital-twin frontend e2e suite.
 *
 * Phase A.7. Runs against the dev server (Vite) — does NOT spin one up
 * because Phase A is exercised against the live stack the user is already
 * running locally. CI integration can add a `webServer` block later.
 *
 * Default baseURL is :5174 because :5173 may be held by a zombie socket
 * on this dev machine (the OneDrive backend's frontend bound it, died,
 * and Windows hasn't released it). Override via PLAYWRIGHT_BASE_URL when
 * the port shifts.
 */
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5174";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
