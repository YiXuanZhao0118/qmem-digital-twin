// @vitest-environment happy-dom
//
// GLTFExporter's binary path uses FileReader/Blob, which the default node test
// environment lacks. happy-dom (scoped to this file) supplies them without
// touching the global test config.
/**
 * Asset-layer M2 §B-1: prove the headless pipeline STEP -> coloured geometry ->
 * merged -> binary GLB works end to end in this runtime, and that the GLB keeps
 * a vertex-colour attribute (colour fidelity, the whole point of going through
 * occt instead of the colour-dropping FreeCAD path).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { importStep, occtResultToGeometry } from "../occtImport";
import { exportGlb, mergeColoredGeometries } from "../glbExport";

// happy-dom rewrites import.meta.url to a non-file URL, so resolve the fixture
// from the (frontend) cwd that `npm run test` runs in instead.
const FIXTURE = resolve(process.cwd(), "src/three/__tests__/fixtures/as1_pe_203.stp");

// GLB binary header magic: 0x46546C67 == "glTF" (little-endian uint32).
const GLB_MAGIC = 0x46546c67;

describe("glbExport pipeline", () => {
  it("exports a STEP import to a valid binary GLB", async () => {
    const data = new Uint8Array(readFileSync(FIXTURE));
    const result = await importStep(data);

    const merged = mergeColoredGeometries(occtResultToGeometry(result));
    expect(merged.getAttribute("color")).toBeTruthy();

    const glb = await exportGlb(merged);
    expect(glb.byteLength).toBeGreaterThan(0);

    const header = new DataView(glb);
    expect(header.getUint32(0, true)).toBe(GLB_MAGIC);

    // The COLOR_0 accessor name appears in the glTF JSON chunk only when the
    // colour attribute was exported — a cheap proof colour survived the bake.
    const text = new TextDecoder().decode(new Uint8Array(glb));
    expect(text).toContain("COLOR_0");
  }, 60000);
});
