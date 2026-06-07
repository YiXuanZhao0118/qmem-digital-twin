/**
 * A-3 (Asset-layer M1): a non-viewer-ready asset file — a CAD source left on
 * disk, or a STEP->STL conversion that failed — must NOT silently fall back to
 * a generic primitive (which masqueraded as real geometry). `loadAssetObject`
 * returns a recognisable placeholder and logs loudly so the failure is visible.
 */

import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

// The vitest runtime lacks the DOM `ProgressEvent` global that three's
// FileLoader constructs while streaming. An unrelated load kicked off when the
// loadAsset module graph is imported streams mid-test and would surface as an
// unhandled rejection that flags this (placeholder-only) test. Define it before
// any import via vi.hoisted; the global test-env fix is tracked separately.
vi.hoisted(() => {
  if (typeof (globalThis as { ProgressEvent?: unknown }).ProgressEvent === "undefined") {
    (globalThis as { ProgressEvent?: unknown }).ProgressEvent = class {
      constructor(public type: string) {}
    };
  }
});

import { loadAssetObject } from "../loadAsset";
import type { Asset3D, ComponentItem } from "../../types/digitalTwin";

// A .step file path that matches none of the bespoke builders and is not a
// `primitive://` path, so it reaches the viewer-ready extension gate and falls
// into the non-renderable branch under test.
const CAD_SOURCE_ASSET = {
  id: "asset_step",
  name: "raw_step_part",
  filePath: "files/cad_sources/raw_step_part.step",
  unit: "mm",
  scaleFactor: 1,
  properties: {},
} as unknown as Asset3D;

// kindId "none" reproduces a generic uploaded asset (no plugin renderer would
// otherwise intercept it before the extension gate).
const COMPONENT = {
  id: "comp_step",
  name: "step_component",
  kindId: "none",
  properties: {},
} as unknown as ComponentItem;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadAssetObject unsupported-format placeholder", () => {
  it("returns a marked placeholder (not a primitive) and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const obj = await loadAssetObject(
      COMPONENT, CAD_SOURCE_ASSET, undefined, null, null, null,
    );

    const mesh = obj.children[0] as THREE.Mesh;
    expect(mesh).toBeDefined();
    // The placeholder self-identifies; the generic primitive box never sets
    // this marker — so this distinguishes the two paths.
    expect(mesh.userData.unsupportedAsset).toEqual({ extension: "step" });
    expect((mesh.material as THREE.MeshBasicMaterial).wireframe).toBe(true);

    // Loud, not silent.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("step_component");
  });
});
