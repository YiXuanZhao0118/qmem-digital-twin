/**
 * Phase C.10 e2e: EM workspace mock palace round-trip.
 *
 * Verifies the Phase C.5+C.7 path end-to-end with the mock palace
 * solver (synthetic Lorentzian S-matrix). The real palace dispatch
 * over SSH lands in Phase C.4 — once it does this test stays useful as
 * long as workstation has palace + the runner agent up.
 *
 * Tests:
 *   1. EM tab shows the EmWorkspace structure (sidebar + editor +
 *      results pane + mesh upload widget).
 *   2. New + Run round-trip: creates a default EM problem, dispatches
 *      em_fem, status hits 'completed' within 15 s, Smith chart +
 *      magnitude plot appear.
 */
import { expect, test } from "@playwright/test";

test.describe("EM workspace", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("tablist", { name: "Simulation module" })).toBeVisible();
    await page.getByRole("tab", { name: /^EM$/ }).click();
    await expect(page.locator(".electronics-workspace")).toBeVisible();
  });

  test("renders three panes + mesh upload control", async ({ page }) => {
    await expect(page.locator(".electronics-sidebar").first()).toBeVisible();
    // Two sidebar headers: EM problems + Meshes.
    const titles = page.locator(".electronics-sidebar .electronics-sidebar-title");
    await expect(titles.first()).toContainText(/EM problems/i);
    await expect(titles.last()).toContainText(/Meshes/i);
    // Right pane present.
    await expect(page.locator(".electronics-results .electronics-sidebar-title")).toContainText(
      /Latest run/i,
    );
  });

  test("New + Run round-trip produces a Smith chart + magnitude plot", async ({ page }) => {
    // Click the "+" New button on the EM problems list (first sidebar
    // icon-btn in the EM workspace).
    await page.locator(".electronics-sidebar .electronics-icon-btn").first().click();
    // The new problem auto-selects and shows the editor with two
    // default ports.
    await expect(page.locator(".em-port-table tbody tr")).toHaveCount(2);
    await expect(page.locator(".em-editor-section h3").first()).toBeVisible();

    // Click Run.
    await page.locator(".electronics-btn.primary").click();

    // Wait for status='completed'. Mock palace + InProcessRunner +
    // WS-driven refetch — should finish in well under 15 s.
    const statusBadge = page.locator(".electronics-result-meta dd").first();
    await expect(statusBadge).toHaveText("completed", { timeout: 15_000 });

    // Smith chart + magnitude plot land via NetworkAnalysisChart.
    await expect(page.locator(".smith-chart-svg")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".magnitude-plot-canvas canvas").first()).toBeVisible();

    // The mock-solver banner shows up so the user knows it's not real
    // palace output yet.
    await expect(page.locator(".em-solver-note")).toContainText(/mock/i);

    // SolverConsole's recent-runs list grows with an em_fem row.
    await expect(
      page.locator(".solver-console-run-row", { hasText: "em_fem" }).first(),
    ).toBeVisible();

    // Phase C.8: vtk.js field viewer renders the mock |E|² volume.
    await expect(page.locator(".field-viewer-block")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".field-viewer-title")).toContainText(/\|E\|/);
    await expect(page.locator(".field-viewer-canvas canvas")).toBeVisible();
  });
});
