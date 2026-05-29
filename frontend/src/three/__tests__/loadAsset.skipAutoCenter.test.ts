/**
 * Regression test for the binding-tree render gate in `loadAssetObject`.
 *
 * The binding-tree renderer positions every sub-piece purely by its
 * ComponentBinding pose (matching the ComponentsV2Editor preview and the
 * backend solver). The legacy single-asset path, however, auto-offsets the
 * mesh — apertureForward shift, else bbox-center. For a multi-part assembly
 * (the IO-3-850-HP isolator: faraday body + front/back housing halves) that
 * per-piece bbox-centering collapses every piece onto the origin, so the
 * lab view looked nothing like the editor.
 *
 * The fix: the binding-tree loader callback passes `skipAutoCenter: true`,
 * which suppresses the whole auto-offset block. This test pins that gate so
 * a future refactor can't silently drop it and reintroduce the collapse.
 */

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

// Mock the STL loader so no real file IO happens. Return a unit box shoved
// +50mm off-origin in X, so its bbox center is unambiguously NOT the origin
// — that makes the auto-offset (when it runs) produce a clearly non-zero
// position shift we can assert on.
vi.mock("three/examples/jsm/loaders/STLLoader.js", () => {
  return {
    STLLoader: class {
      async loadAsync(): Promise<THREE.BufferGeometry> {
        const three = await import("three");
        const geo = new three.BoxGeometry(1, 1, 1);
        geo.translate(50, 0, 0);
        return geo;
      }
    },
  };
});

import { loadAssetObject } from "../loadAsset";
import type { Asset3D, ComponentItem } from "../../types/digitalTwin";


// A plain STL asset that matches none of the bespoke builders
// (BB1E03 / Wphsm05 / Pbs252 / Ad9959 / Thorlabs-isolator), so it lands on
// the generic `new THREE.Mesh(geometry, material)` branch → the wrapper
// auto-offset block under test.
const PLAIN_STL_ASSET = {
  id: "asset_plain_box",
  name: "plain_box",
  filePath: "files/stl/plain_box.stl",
  unit: "mm",
  scaleFactor: 1,
  properties: {},
} as unknown as Asset3D;

// kindId "none" + no apertureForward property reproduces the IO-3-850-HP
// composite Component exactly: its kindId is "none" (not "isolator"), which
// is precisely why the legacy `else if (kindId !== "isolator")` guard let the
// bbox-center fire on every binding-tree piece.
const PLAIN_COMPONENT = {
  id: "comp_plain",
  name: "plain_component",
  kindId: "none",
  properties: {},
} as unknown as ComponentItem;


describe("loadAssetObject skipAutoCenter gate", () => {
  it("auto-offsets the mesh when skipAutoCenter is absent (legacy path)", async () => {
    const wrapper = await loadAssetObject(
      PLAIN_COMPONENT, PLAIN_STL_ASSET, undefined, null, null, null,
    );
    const inner = wrapper.children[0];
    expect(inner).toBeDefined();
    // The off-origin geometry triggered the bbox-center shift, so the inner
    // object was pushed off (0,0,0).
    expect(inner.position.length()).toBeGreaterThan(0);
  });

  it("leaves the mesh at its binding pose when skipAutoCenter is true", async () => {
    const wrapper = await loadAssetObject(
      PLAIN_COMPONENT, PLAIN_STL_ASSET, undefined, null, null,
      { skipAutoCenter: true },
    );
    const inner = wrapper.children[0];
    expect(inner).toBeDefined();
    // The gate suppressed the auto-offset: the piece stays where its
    // binding pose put it (the wrapper, here at the origin).
    expect(inner.position.x).toBe(0);
    expect(inner.position.y).toBe(0);
    expect(inner.position.z).toBe(0);
  });
});
