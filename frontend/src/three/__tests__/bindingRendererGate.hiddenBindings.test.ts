/**
 * Per-instance hidden parts — `SceneObject.properties.hiddenBindings`.
 *
 * The case this exists for: "Mech Post 1 inch" is an RS1P post with a
 * CF125C_M clamping fork bound under it, and a post standing in a mounting
 * hole wears no fork. Dropping the binding row is not an option — it is the
 * shared catalog Component, and the row carries the calibrated pose plus the
 * tunable RZ the Object panel adjusts per instance.
 *
 * So: hiding is render-only and per instance. What this pins is that hiding
 * removes the geometry, leaves the tree and the instance's RZ delta alone,
 * and that unhiding brings the part back in exactly the pose it had.
 */

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

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
  ObjectBinding,
  SceneData,
  SceneObject,
} from "../../types/digitalTwin";


const asset = (id: string) =>
  ({
    id,
    name: id,
    filePath: `files/stl/${id}.stl`,
    unit: "mm",
    scaleFactor: 1,
    properties: {},
  }) as unknown as Asset3D;

const POST_ASSET = asset("rs1p");
const FORK_ASSET = asset("cf125c_m");

const COMPONENT = {
  id: "comp_post",
  name: "Mech Post 1 inch",
  kindId: "mechanical",
  properties: {},
} as unknown as ComponentItem;

const POST_BINDING = {
  id: "b_post",
  componentId: "comp_post",
  parentBindingId: null,
  targetKind: "asset",
  asset3dId: "rs1p",
  subComponentId: null,
  role: "RS1P-Step",
  localXMm: 0, localYMm: 0, localZMm: 0,
  localRxDeg: 0, localRyDeg: 0, localRzDeg: 0,
  tunableAxes: {},
  sortOrder: 0,
  properties: {},
} as unknown as ComponentBinding;

const FORK_BINDING = {
  ...POST_BINDING,
  id: "b_fork",
  parentBindingId: "b_post",
  asset3dId: "cf125c_m",
  role: "CF125C_M-Step",
  tunableAxes: { localRzDeg: { frame: "parent" } },
  sortOrder: 1,
} as unknown as ComponentBinding;

/** This instance turned the fork 30° — the delta the user must not lose. */
const FORK_RZ_DELTA = {
  id: "ob1",
  objectId: "obj1",
  componentBindingId: "b_fork",
  localRzDegDelta: 30,
} as unknown as ObjectBinding;

const objectWith = (hiddenBindings?: string[]) =>
  ({
    id: "obj1",
    name: "Post0",
    componentId: "comp_post",
    properties: hiddenBindings ? { hiddenBindings } : {},
  }) as unknown as SceneObject;

const COMPONENT_BINDINGS = [POST_BINDING, FORK_BINDING];
const OBJECT_BINDINGS = [FORK_RZ_DELTA];

const SCENE = {
  componentBindings: COMPONENT_BINDINGS,
  objectBindings: OBJECT_BINDINGS,
  assets: [POST_ASSET, FORK_ASSET],
  components: [COMPONENT],
} as unknown as Pick<
  SceneData,
  "componentBindings" | "objectBindings" | "assets" | "components"
>;

/** Every binding id the built tree drew a pivot for. */
function renderedBindingIds(root: THREE.Object3D): Set<string> {
  const out = new Set<string>();
  root.traverse((o) => {
    const id = o.userData?.__bindingId;
    if (typeof id === "string") out.add(id);
  });
  return out;
}

function pivotFor(root: THREE.Object3D, bindingId: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (found === null && o.userData?.__bindingId === bindingId && o.type === "Group") {
      found = o;
    }
  });
  return found;
}


describe("hiddenBindings", () => {
  it("draws every part when the instance hides nothing", async () => {
    const group = await buildSceneObjectFromBindings(COMPONENT, objectWith(), SCENE);
    expect(renderedBindingIds(group)).toEqual(new Set(["b_post", "b_fork"]));
  });

  it("skips a hidden binding's geometry and keeps the rest", async () => {
    const group = await buildSceneObjectFromBindings(
      COMPONENT,
      objectWith(["b_fork"]),
      SCENE,
    );
    const drawn = renderedBindingIds(group);
    expect(drawn.has("b_fork")).toBe(false);
    expect(drawn.has("b_post")).toBe(true);
  });

  it("leaves the binding tree and the instance's RZ delta untouched", async () => {
    await buildSceneObjectFromBindings(COMPONENT, objectWith(["b_fork"]), SCENE);
    // Hiding is render-only: nothing is removed from the catalog tree and
    // no override row is cleared, which is what makes it reversible.
    expect(COMPONENT_BINDINGS).toHaveLength(2);
    expect(OBJECT_BINDINGS[0].localRzDegDelta).toBe(30);
  });

  it("restores the part in its adjusted pose when unhidden", async () => {
    const group = await buildSceneObjectFromBindings(COMPONENT, objectWith(), SCENE);
    const pivot = pivotFor(group, "b_fork");
    expect(pivot).not.toBeNull();
    // baseline localRzDeg 0 + the instance's 30° delta.
    const euler = new THREE.Euler().setFromQuaternion(pivot!.quaternion, "XYZ");
    expect(THREE.MathUtils.radToDeg(euler.z)).toBeCloseTo(30, 6);
  });

  it("hides the subtree of a hidden part — nothing floats off the post", async () => {
    const group = await buildSceneObjectFromBindings(
      COMPONENT,
      objectWith(["b_post"]),
      SCENE,
    );
    expect(renderedBindingIds(group).size).toBe(0);
  });
});
