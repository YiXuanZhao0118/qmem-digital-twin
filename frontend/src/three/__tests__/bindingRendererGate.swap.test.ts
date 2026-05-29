/**
 * Regression test for the CAD→three basis swap in
 * `buildSceneObjectFromBindings`.
 *
 * The binding tree is assembled in the component's CAD frame (Z-up, raw
 * mm/100 — see bindingTreeObject.ts "Frame contract"). The backend beam
 * (labMmToThree) and every legacy GLB asset (Blender→glTF baked swap)
 * live in three's Y-up frame. The binding tree's STEP→STL sub-assets
 * carry no such bake, so `buildSceneObjectFromBindings` must apply ONE
 * rigid Rx(-90°) swap to the whole assembly. Without it the IO-3-850-HP
 * bore rendered 90° (Z↔Y) off from its own beam (the beam shot
 * perpendicular to the housing in the lab).
 *
 * This pins the swap so a refactor can't drop it (→ the 90°-off bug) or
 * reintroduce a per-binding swap (which scattered the glan pieces; see the
 * ⚠ note in bindingTreeObject.ts).
 */

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

// Mock the STL loader so no real file IO happens — a unit box at the
// origin is enough; we assert on the binding wrapper's transform, not the
// mesh geometry.
vi.mock("three/examples/jsm/loaders/STLLoader.js", () => {
  return {
    STLLoader: class {
      async loadAsync(): Promise<THREE.BufferGeometry> {
        const three = await import("three");
        return new three.BoxGeometry(1, 1, 1);
      }
    },
  };
});

import { buildSceneObjectFromBindings } from "../bindingRendererGate";
import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  SceneData,
} from "../../types/digitalTwin";


const PLAIN_STL_ASSET = {
  id: "asset_box",
  name: "box",
  filePath: "files/stl/box.stl",
  unit: "mm",
  scaleFactor: 1,
  properties: {},
} as unknown as Asset3D;

const COMPONENT = {
  id: "comp1",
  name: "comp1",
  kindId: "none",
  properties: {},
} as unknown as ComponentItem;

// Single root binding pointing at the box asset, offset +5mm along the
// component's body-local +Z (the optical axis for an in-line device).
const ROOT_BINDING = {
  id: "b1",
  componentId: "comp1",
  parentBindingId: null,
  targetKind: "asset",
  asset3dId: "asset_box",
  subComponentId: null,
  localXMm: 0,
  localYMm: 0,
  localZMm: 5,
  localRxDeg: 0,
  localRyDeg: 0,
  localRzDeg: 0,
  tunableAxes: {},
  properties: {},
} as unknown as ComponentBinding;

const SCENE = {
  componentBindings: [ROOT_BINDING],
  objectBindings: [],
  assets: [PLAIN_STL_ASSET],
  components: [COMPONENT],
} as unknown as Pick<
  SceneData,
  "componentBindings" | "objectBindings" | "assets" | "components"
>;


describe("buildSceneObjectFromBindings CAD→three basis swap", () => {
  it("maps a body-local +Z binding offset onto three +Y (the beam frame)", async () => {
    const group = await buildSceneObjectFromBindings(COMPONENT, null, SCENE);
    group.updateMatrixWorld(true);

    // group = swap wrapper (Rx(-90°)); its child is the assembled content;
    // the content's child is the loaded asset wrapper, whose local position
    // was set by applyBindingLocalTransform from the binding's +5mm Z.
    const content = group.children[0];
    expect(content).toBeDefined();
    const piece = content.children[0];
    expect(piece).toBeDefined();

    const world = new THREE.Vector3();
    piece.getWorldPosition(world);

    // +5mm body-local Z → mmToThree = +0.05 in the RAW frame. The Rx(-90°)
    // swap must rotate that onto three +Y: (0, +0.05, 0), NOT +Z (0, 0, 0.05).
    expect(world.x).toBeCloseTo(0, 5);
    expect(world.y).toBeCloseTo(0.05, 5);
    expect(world.z).toBeCloseTo(0, 5);
  });
});
