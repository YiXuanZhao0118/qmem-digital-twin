/**
 * Phase A.7 + B.8 e2e: ModuleSwitcher round-trip + workspace
 * conditional render.
 *
 * Phase A.7 baseline:
 *   - top-bar tab strip lists Optics + Electronics + EM.
 *   - Optics + Electronics are available workspaces (post Phase B.4).
 *   - EM is still placeholder until Phase C.
 *   - Switching modules swaps the canvas content and SolverConsole
 *     stays mounted across optics_seq + spice.
 */
import { expect, test } from "@playwright/test";

test.describe("Module switcher", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("tablist", { name: "Simulation module" })).toBeVisible();
  });

  test("top bar lists Optics + Electronics + EM", async ({ page }) => {
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toContainText("Optics");
    await expect(tabs.nth(1)).toContainText("Electronics");
    await expect(tabs.nth(2)).toContainText("EM");
  });

  test("Optics + Electronics + EM are all available (Phase A+B+C done)", async ({ page }) => {
    await expect(page.getByRole("tab", { name: /^Optics$/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tab", { name: /^Optics$/ })).not.toHaveClass(/coming-soon/);
    await expect(page.getByRole("tab", { name: /^Electronics/ })).not.toHaveClass(/coming-soon/);
    await expect(page.getByRole("tab", { name: /^EM$/ })).not.toHaveClass(/coming-soon/);
  });

  test("Optics workspace shows SolverConsole + 3D viewer", async ({ page }) => {
    await expect(page.locator(".solver-console")).toBeVisible();
    await expect(page.locator(".solver-console-run")).toContainText(/Run/);
    // .workspace-canvas > .viewer-shell, .workspace-canvas > .dual-viewer-split is the 3D viewer wrapper — unique to Optics.
    await expect(page.locator(".workspace-canvas > .viewer-shell, .workspace-canvas > .dual-viewer-split")).toBeVisible();
    await expect(page.locator(".module-placeholder")).toHaveCount(0);
    await expect(page.locator(".electronics-workspace")).toHaveCount(0);
  });

  test("Optics -> Electronics -> EM -> Optics round-trip", async ({ page }) => {
    // To Electronics: workspace replaces 3D viewer; SolverConsole stays.
    await page.getByRole("tab", { name: /^Electronics/ }).click();
    await expect(page.locator(".electronics-workspace")).toBeVisible();
    await expect(page.locator(".electronics-sidebar").first()).toBeVisible();
    await expect(page.locator(".electronics-editor")).toBeVisible();
    await expect(page.locator(".electronics-results")).toBeVisible();
    await expect(page.locator(".solver-console")).toBeVisible(); // shared
    await expect(page.locator(".workspace-canvas > .viewer-shell, .workspace-canvas > .dual-viewer-split")).toHaveCount(0);
    await expect(page.locator(".module-placeholder")).toHaveCount(0);

    // To EM: EmWorkspace mounts (also reuses .electronics-workspace shell).
    // Distinguish from Electronics by the EM-specific port table presence
    // (only EM editor renders that) — but to keep this test cheap we
    // check the EM problems sidebar header text.
    await page.getByRole("tab", { name: /^EM$/ }).click();
    await expect(page.locator(".electronics-workspace")).toBeVisible();
    await expect(
      page.locator(".electronics-sidebar .electronics-sidebar-title").first(),
    ).toContainText(/EM problems/i);
    await expect(page.locator(".solver-console")).toBeVisible(); // shared across all 3
    await expect(page.locator(".module-placeholder")).toHaveCount(0);

    // Back to Optics: viewer + SolverConsole reappear.
    await page.getByRole("tab", { name: /^Optics$/ }).click();
    await expect(page.locator(".workspace-canvas > .viewer-shell, .workspace-canvas > .dual-viewer-split")).toBeVisible();
    await expect(page.locator(".solver-console")).toBeVisible();
    await expect(page.locator(".module-placeholder")).toHaveCount(0);
    await expect(page.locator(".electronics-workspace")).toHaveCount(0);
  });
});
