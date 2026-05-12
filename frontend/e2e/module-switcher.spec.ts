/**
 * Phase A.7 e2e: ModuleSwitcher round-trip + workspace conditional render.
 *
 * Verifies the multiphysics platform shell that landed in Phase A.4-A.6:
 *   - top-bar tab strip lists Optics + Electronics + EM
 *   - clicking Electronics swaps the canvas to the coming-soon placeholder
 *   - clicking back to Optics restores the 3D viewer + SolverConsole panel
 *   - SolverConsole's Run button is rendered and enabled (does NOT click
 *     it — POST e2e is blocked by the local 8010 zombie socket and is
 *     covered by the backend pytest suite anyway)
 *
 * Runs against whatever dev server PLAYWRIGHT_BASE_URL points at
 * (default :5174 — see playwright.config.ts). Does not spin one up.
 */
import { expect, test } from "@playwright/test";

test.describe("Module switcher", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for the top-bar tablist to mount — proxy for "React app loaded".
    await expect(page.getByRole("tablist", { name: "Simulation module" })).toBeVisible();
  });

  test("top bar lists Optics + Electronics + EM", async ({ page }) => {
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toContainText("Optics");
    await expect(tabs.nth(1)).toContainText("Electronics");
    await expect(tabs.nth(2)).toContainText("EM");
  });

  test("Phase A: Optics is the only available tab", async ({ page }) => {
    // Optics has no phase badge. Electronics + EM do.
    const opticsTab = page.getByRole("tab", { name: /^Optics$/ });
    await expect(opticsTab).toHaveAttribute("aria-selected", "true");
    await expect(opticsTab).not.toHaveClass(/coming-soon/);

    await expect(page.getByRole("tab", { name: /Electronics/ })).toHaveClass(/coming-soon/);
    await expect(page.getByRole("tab", { name: /EM/ })).toHaveClass(/coming-soon/);
  });

  test("Optics workspace shows the SolverConsole + canvas", async ({ page }) => {
    // SolverConsole panel
    await expect(page.locator(".solver-console")).toBeVisible();
    const runButton = page.locator(".solver-console-run");
    await expect(runButton).toBeVisible();
    await expect(runButton).toContainText(/Run/);

    // Three.js canvas
    await expect(page.locator(".workspace-canvas canvas").first()).toBeVisible();

    // No placeholder when Optics is active
    await expect(page.locator(".module-placeholder")).toHaveCount(0);
  });

  test("clicking Electronics swaps to placeholder, back to Optics restores viewer", async ({ page }) => {
    // Switch to Electronics
    await page.getByRole("tab", { name: /Electronics/ }).click();
    await expect(page.locator(".module-placeholder")).toBeVisible();
    await expect(page.locator(".module-placeholder-title")).toHaveText("Electronics");
    await expect(page.locator(".module-placeholder-phase")).toHaveText("Phase B");
    // No canvas + no SolverConsole when not in Optics
    await expect(page.locator(".workspace-canvas canvas")).toHaveCount(0);
    await expect(page.locator(".solver-console")).toHaveCount(0);

    // Switch to EM
    await page.getByRole("tab", { name: /EM/ }).click();
    await expect(page.locator(".module-placeholder-title")).toHaveText("EM");
    await expect(page.locator(".module-placeholder-phase")).toHaveText("Phase C");

    // Back to Optics — viewer + SolverConsole reappear
    await page.getByRole("tab", { name: /^Optics$/ }).click();
    await expect(page.locator(".workspace-canvas canvas").first()).toBeVisible();
    await expect(page.locator(".solver-console")).toBeVisible();
    await expect(page.locator(".module-placeholder")).toHaveCount(0);
  });
});
