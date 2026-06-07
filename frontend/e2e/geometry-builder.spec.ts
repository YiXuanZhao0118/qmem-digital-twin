/**
 * Asset-layer M2 §B e2e: the Geometry Builder tab end to end against the live
 * stack. Imports a real STEP (the 18-mesh as1_pe_203 assembly) in-browser via
 * occt-import-js, then exercises decimation (§B-2) and part de-selection /
 * split (§B-3). Stops before Save so it doesn't write to the dev catalog — the
 * export + upload path is covered by the glbExport + upload-route unit tests.
 */
import { expect, test } from "@playwright/test";

const FIXTURE = "src/three/__tests__/fixtures/as1_pe_203.stp";

function parseTris(text: string | null): number {
  if (!text) return 0;
  const m = text.replace(/,/g, "").match(/(\d+)\s*tris/);
  return m ? Number(m[1]) : 0;
}

test.describe("Geometry Builder", () => {
  test.beforeEach(async ({ page }) => {
    // Land straight in the PhyEditor BUILD tab.
    await page.addInitScript(() => {
      localStorage.setItem(
        "qmem.editorState",
        JSON.stringify({
          editorMode: "phy-editor",
          phyEditorView: { section: "builder", domain: "all" },
        }),
      );
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Geometry Builder" })).toBeVisible();
  });

  test("import STEP → one source, decimate, merge + exclude", async ({ page }) => {
    await page.setInputFiles('input[type="file"]', FIXTURE);

    // One file = one source unit (its meshes merged).
    await expect(page.getByText(/Sources \(\d+\/\d+\)/)).toBeVisible({ timeout: 20_000 });

    const readout = page.getByText(/tris ·/);
    await expect(readout).toBeVisible();
    const oneTris = parseTris(await readout.textContent());
    expect(oneTris).toBeGreaterThan(0);

    // §B-2: drag the slider down → triangle count drops. (Presets target
    // 30k–300k, above this small fixture's count, so use the slider.)
    const slider = page.locator('input[type="range"]');
    await slider.fill("1000");
    await expect
      .poll(async () => parseTris(await readout.textContent()), { timeout: 10_000 })
      .toBeLessThan(oneTris);

    // Back to full res.
    await page.getByRole("button", { name: "Full" }).click();
    await expect
      .poll(async () => parseTris(await readout.textContent()), { timeout: 10_000 })
      .toBe(oneTris);

    // §B-4: add a second source (merge) → more triangles.
    await page.setInputFiles('input[type="file"]', FIXTURE);
    await expect
      .poll(async () => parseTris(await readout.textContent()), { timeout: 20_000 })
      .toBeGreaterThan(oneTris);
    const twoTris = parseTris(await readout.textContent());

    // §B-3: untick one source (exclude it) → triangle count drops back.
    await page.locator('input[type="checkbox"]').first().uncheck();
    await expect
      .poll(async () => parseTris(await readout.textContent()), { timeout: 10_000 })
      .toBeLessThan(twoTris);
  });
});
