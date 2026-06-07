/**
 * Keystone test for Asset-layer M2 §B-1: prove `occt-import-js` parses a real
 * STEP file into coloured, three.js-ready geometry in this runtime (no server,
 * no FreeCAD). `as1_pe_203.stp` is the package's canonical coloured assembly —
 * 18 meshes, every one carrying an explicit colour.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { importStep, occtMeshToGeometry } from "../occtImport";

const FIXTURE = fileURLToPath(new URL("./fixtures/as1_pe_203.stp", import.meta.url));

describe("occtImport STEP loader", () => {
  it("parses a coloured STEP into meshes with geometry + colour", async () => {
    const data = new Uint8Array(readFileSync(FIXTURE));
    const result = await importStep(data);

    expect(result.success).toBe(true);
    expect(result.meshes.length).toBe(18);
    for (const mesh of result.meshes) {
      expect(mesh.attributes.position.array.length).toBeGreaterThan(0);
      expect(mesh.index.array.length).toBeGreaterThan(0);
      expect(mesh.color).toBeDefined();
    }
  }, 60000);

  it("bakes per-face colour into a de-indexed vertex-colour geometry", async () => {
    const data = new Uint8Array(readFileSync(FIXTURE));
    const result = await importStep(data);
    const mesh = result.meshes[0];

    const geom = occtMeshToGeometry(mesh);
    const pos = geom.getAttribute("position");
    const col = geom.getAttribute("color");

    expect(pos).toBeTruthy();
    expect(col).toBeTruthy();
    // De-indexed: exactly one vertex per triangle corner.
    expect(pos.count).toBe(mesh.index.array.length);
    expect(col.count).toBe(pos.count);

    // Colour channels are valid 0..1.
    for (const c of [col.getX(0), col.getY(0), col.getZ(0)]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  }, 60000);
});
