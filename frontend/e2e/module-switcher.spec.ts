/**
 * Module switcher e2e.
 *
 * As of 2026-06-10 the only top-level tab is the integrated Lab
 * (optics_seq); the Optics / Electronics / EM tabs — and their backend
 * solvers / DB tables — were removed. This pins that the switcher shows
 * exactly one tab and renders the 3D viewer (not a placeholder).
 */
import { expect, test } from "@playwright/test";

test.describe("Module switcher", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("tablist", { name: "Simulation module" })).toBeVisible();
  });

  test("shows only the Lab tab", async ({ page }) => {
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(1);
    await expect(tabs.nth(0)).toContainText("Lab");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  });

  test("Lab tab shows the 3D viewer", async ({ page }) => {
    // DualViewerSplit renders under .workspace-canvas > .workspace-center,
    // so match the viewer as a descendant (not a direct child).
    await expect(
      page.locator(".workspace-canvas .viewer-shell, .workspace-canvas .dual-viewer-split").first(),
    ).toBeVisible();
    await expect(page.locator(".module-placeholder")).toHaveCount(0);
    await expect(page.locator(".electronics-workspace")).toHaveCount(0);
  });
});
