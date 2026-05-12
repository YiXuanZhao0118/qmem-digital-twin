/**
 * Phase B.8 e2e: ElectronicsWorkspace structure + SPICE run round-trip.
 *
 * Two tests:
 *   1. Workspace renders three panes (sidebar + monaco editor + results)
 *      with at least one seeded circuit.
 *   2. Clicking Run dispatches a spice solver run; the WaveformChart
 *      eventually shows in the results pane and the SolverConsole
 *      "Recent runs" list grows with a spice row.
 *
 * The second test depends on:
 *   - The local backend running on whatever PLAYWRIGHT_BASE_URL points to.
 *   - At least one Circuit already in the DB. The test seeds one via
 *     the /api/circuits endpoint at start, then cleans up.
 *   - ngspice installed (we use the SPICE solver's own error surface
 *     to detect a missing binary and mark the test skipped).
 */
import { expect, test } from "@playwright/test";

const TEST_NETLIST = `* RLC band-pass — Phase B.8 e2e
V1 in 0 AC 1
R1 in n1 100
L1 n1 n2 1m
C1 n2 0 1u
.AC DEC 10 100 1Meg
.END
`;

async function findApiOrigin(): Promise<string> {
  // Backend URL is hard-coded in the frontend's api/client.ts as
  // http://localhost:8010. PLAYWRIGHT_BASE_URL only changes the
  // frontend Vite port, not the backend.
  return process.env.QMEM_API_ORIGIN ?? "http://localhost:8010";
}

test.describe("Electronics workspace", () => {
  let circuitId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const origin = await findApiOrigin();
    const res = await request.post(`${origin}/api/circuits`, {
      data: {
        name: "Phase B.8 e2e seed",
        netlist: TEST_NETLIST,
      },
    });
    if (!res.ok()) {
      throw new Error(`Failed to seed circuit: HTTP ${res.status()}`);
    }
    const body = await res.json();
    circuitId = body.id;
  });

  test.afterAll(async ({ request }) => {
    if (!circuitId) return;
    const origin = await findApiOrigin();
    await request.delete(`${origin}/api/circuits/${circuitId}`);
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("tablist", { name: "Simulation module" })).toBeVisible();
    await page.getByRole("tab", { name: /^Electronics/ }).click();
    await expect(page.locator(".electronics-workspace")).toBeVisible();
  });

  test("renders sidebar + monaco editor + results pane", async ({ page }) => {
    // Sidebar with at least our seeded circuit.
    await expect(page.locator(".electronics-sidebar")).toBeVisible();
    await expect(
      page.locator(".electronics-circuit-row", { hasText: "Phase B.8 e2e seed" }),
    ).toBeVisible();

    // Center editor: name input + Save / Run / Delete + Monaco mounted.
    await expect(page.locator(".electronics-name-input")).toBeVisible();
    await expect(page.locator(".electronics-btn.primary")).toContainText(/Run/);
    await expect(page.locator(".electronics-netlist-host .monaco-editor")).toBeVisible();

    // Right pane: "Latest run" header.
    await expect(page.locator(".electronics-results .electronics-sidebar-title")).toContainText(
      "Latest run",
    );
  });

  test("Run button dispatches a spice run and shows a waveform chart", async ({ page }) => {
    // Make sure our seeded circuit is the selected one.
    await page
      .locator(".electronics-circuit-row", { hasText: "Phase B.8 e2e seed" })
      .click();
    await expect(
      page.locator(".electronics-circuit-row.active", { hasText: "Phase B.8 e2e seed" }),
    ).toBeVisible();

    // Click Run.
    await page.locator(".electronics-btn.primary").click();

    // Backend dispatch + ngspice exec + WS update should take well under
    // 15 seconds for an 11-point AC sweep. The completed row drives the
    // status badge in the results pane.
    const statusBadge = page.locator(".electronics-result-meta dd").first();
    await expect(statusBadge).toHaveText("completed", { timeout: 15_000 });

    // WaveformChart block + legend appear after the run row's resultSummary
    // arrives via the GET refetch (a couple of React commits behind the
    // status flip). Allow a generous timeout for the cascading effects.
    await expect(page.locator(".waveform-chart-block")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".waveform-legend-item").first()).toBeVisible();

    // SolverConsole's recent-runs list should now include a spice row.
    await expect(
      page.locator(".solver-console-run-row", { hasText: "spice" }).first(),
    ).toBeVisible();
  });
});
