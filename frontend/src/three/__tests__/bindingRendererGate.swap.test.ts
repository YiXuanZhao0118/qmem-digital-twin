/**
 * Frame contract for `buildSceneObjectFromBindings`.
 *
 * The binding tree is assembled in the component's CAD frame (Z-up, raw
 * mm/100 — see bindingTreeObject.ts "Frame contract"), and three is
 * configured Z-up, so the assembly needs NO basis swap: a body-local offset
 * lands on the same three axis it was authored on.
 *
 * This test used to pin the opposite. Back when three was Y-up the gate
 * applied one rigid Rx(-90°) to the whole assembly to match `labMmToThree`,
 * and this file asserted a body-local +Z offset arriving on three +Y. The
 * Z-up migration removed that rotation but left the assertion (and a comment
 * block in bindingRendererGate.ts) behind, so the test had been red since.
 *
 * What still matters, and is what this now pins: the swap must not come back,
 * and it must never be applied per-binding — that scatters the glan pieces
 * (see the ⚠ note in bindingTreeObject.ts).
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


describe("buildSceneObjectFromBindings frame contract", () => {
  it("keeps a body-local +Z binding offset on three +Z — no basis swap", async () => {
    const group = await buildSceneObjectFromBindings(COMPONENT, null, SCENE);
    group.updateMatrixWorld(true);

    // group wraps the assembled content; the content's child is the loaded
    // asset wrapper, whose local position was set by
    // applyBindingLocalTransform from the binding's +5mm Z.
    const content = group.children[0];
    expect(content).toBeDefined();
    const piece = content.children[0];
    expect(piece).toBeDefined();

    const world = new THREE.Vector3();
    piece.getWorldPosition(world);

    // +5mm body-local Z → mmToThree = +0.05, and it stays on Z. A
    // reintroduced Rx(-90°) would move it to (0, +0.05, 0) and Rx(+90°) to
    // (0, -0.05, 0), so asserting all three components pins the absence of
    // the swap AND would name either sign if one came back.
    expect(world.x).toBeCloseTo(0, 5);
    expect(world.y).toBeCloseTo(0, 5);
    expect(world.z).toBeCloseTo(0.05, 5);
  });
});
