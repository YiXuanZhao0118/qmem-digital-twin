/**
 * Tests for the ComponentBinding tree → THREE.Group walker (Stage A''').
 *
 * Focus is on the wiring contract — local transform composition + child
 * group nesting + the loader callback being invoked once per node.
 * Geometry-loading specifics (STL/GLB) belong to the renderer's own
 * loader; here we stub it out with cheap THREE.Group instances.
 */

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import { mmToThree } from "../../optical/frames";
import type {
  ResolvedBindingNode,
  ResolvedLocalTransform,
} from "../../utils/componentBindings";
import { applyBindingLocalTransform, buildBindingTreeObject } from "../bindingTreeObject";


// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------


function makeTransform(overrides: Partial<ResolvedLocalTransform> = {}): ResolvedLocalTransform {
  return {
    xMm: 0,
    yMm: 0,
    zMm: 0,
    rxDeg: 0,
    ryDeg: 0,
    rzDeg: 0,
    ...overrides,
  };
}


function makeNode(
  id: string,
  transform: ResolvedLocalTransform = makeTransform(),
  children: ResolvedBindingNode[] = [],
): ResolvedBindingNode {
  return {
    binding: {
      id,
      componentId: "c",
      parentBindingId: null,
      targetKind: "asset",
      asset3dId: id,
      subComponentId: null,
      role: "body",
      localXMm: transform.xMm,
      localYMm: transform.yMm,
      localZMm: transform.zMm,
      localRxDeg: transform.rxDeg,
      localRyDeg: transform.ryDeg,
      localRzDeg: transform.rzDeg,
      tunableAxes: {},
      sortOrder: 0,
      properties: {},
    },
    target: {
      kind: "asset",
      asset: {
        id,
        name: id,
        assetType: "stl",
        filePath: `files/stl/${id}.stl`,
        unit: "mm",
        scaleFactor: 1,
        anchors: [],
      },
    },
    localTransform: transform,
    children,
  };
}


// ---------------------------------------------------------------------------
// applyBindingLocalTransform — frame conversion
// ---------------------------------------------------------------------------


describe("applyBindingLocalTransform", () => {
  it("maps body-local mm to three units via labMmToThree convention", () => {
    const obj = new THREE.Object3D();
    // x=10, y=20, z=30 body-local → three (10/100, 30/100, -20/100)
    applyBindingLocalTransform(
      obj,
      makeNode("n", makeTransform({ xMm: 10, yMm: 20, zMm: 30 })),
    );
    expect(obj.position.x).toBeCloseTo(mmToThree(10));
    expect(obj.position.y).toBeCloseTo(mmToThree(30));
    expect(obj.position.z).toBeCloseTo(mmToThree(-20));
  });

  it("identity transform yields zero position + identity quaternion", () => {
    const obj = new THREE.Object3D();
    applyBindingLocalTransform(obj, makeNode("n"));
    // toBeCloseTo to tolerate ±0 from THREE.Euler's degToRad(-0) path.
    expect(obj.position.x).toBeCloseTo(0);
    expect(obj.position.y).toBeCloseTo(0);
    expect(obj.position.z).toBeCloseTo(0);
    expect(obj.quaternion.x).toBeCloseTo(0);
    expect(obj.quaternion.y).toBeCloseTo(0);
    expect(obj.quaternion.z).toBeCloseTo(0);
    expect(obj.quaternion.w).toBeCloseTo(1);
  });

  it("rz=90deg rotates +x_body to +y_body (90° around body Z)", () => {
    // Body-frame check: a +X body-direction (1,0,0) should rotate to
    // +Y body (0,1,0) under a +90° body-Z rotation. After labMmToThree
    // axis swap: body (0,1,0) maps to three (0, 0, -1). So a vector
    // at body (1,0,0) — i.e. three (1, 0, 0) — should end up at
    // three (0, 0, -1).
    const obj = new THREE.Object3D();
    applyBindingLocalTransform(obj, makeNode("n", makeTransform({ rzDeg: 90 })));
    const v = new THREE.Vector3(1, 0, 0); // +X in three is also +X in body
    v.applyQuaternion(obj.quaternion);
    expect(v.x).toBeCloseTo(0, 5);
    expect(v.y).toBeCloseTo(0, 5);
    expect(v.z).toBeCloseTo(-1, 5);
  });
});


// ---------------------------------------------------------------------------
// buildBindingTreeObject — walker
// ---------------------------------------------------------------------------


describe("buildBindingTreeObject", () => {
  it("returns an empty Group for an empty tree", async () => {
    const group = await buildBindingTreeObject([], async () => null);
    expect(group.children).toEqual([]);
  });

  it("invokes the loader once per node + wires the returned objects as children", async () => {
    const nodes: ResolvedBindingNode[] = [
      makeNode("a"),
      makeNode("b"),
    ];
    const loader = vi.fn(async (node: ResolvedBindingNode) => {
      const g = new THREE.Group();
      g.name = node.binding.id;
      return g;
    });
    const result = await buildBindingTreeObject(nodes, loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.children).toHaveLength(2);
    expect(result.children.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("skips nodes whose loader returns null (does NOT recurse into their children)", async () => {
    const nodes: ResolvedBindingNode[] = [
      makeNode("kept"),
      makeNode("dropped", makeTransform(), [makeNode("orphan_child")]),
    ];
    const loader = vi.fn(async (node: ResolvedBindingNode) => {
      if (node.binding.id === "dropped") return null;
      const g = new THREE.Group();
      g.name = node.binding.id;
      return g;
    });
    const result = await buildBindingTreeObject(nodes, loader);
    // "dropped" returned null → skipped; "orphan_child" is never visited.
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.children).toHaveLength(1);
    expect(result.children[0].name).toBe("kept");
  });

  it("nests child binding groups under their parent's Object3D", async () => {
    const child = makeNode("child", makeTransform({ xMm: 25 }));
    const root = makeNode("root", makeTransform(), [child]);
    const loader = async (node: ResolvedBindingNode) => {
      const g = new THREE.Group();
      g.name = node.binding.id;
      return g;
    };
    const result = await buildBindingTreeObject([root], loader);
    expect(result.children).toHaveLength(1);
    const rootObj = result.children[0];
    // Children become a nested Group attached to the parent's Object3D
    // (the inner Group itself contains the child loaded object).
    expect(rootObj.children).toHaveLength(1);
    const childGroup = rootObj.children[0];
    expect(childGroup.children).toHaveLength(1);
    expect(childGroup.children[0].name).toBe("child");
    // Local transform applied: x=25 mm → x=mmToThree(25) in three.
    expect(childGroup.children[0].position.x).toBeCloseTo(mmToThree(25));
  });

  it("tags every loaded object with its binding id for selection round-trip", async () => {
    const nodes: ResolvedBindingNode[] = [makeNode("the_root")];
    const loader = async () => new THREE.Group();
    const result = await buildBindingTreeObject(nodes, loader);
    expect(result.children[0].userData.__bindingId).toBe("the_root");
  });
});
