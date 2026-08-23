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
import type { FiberNode } from "../loadAsset/fiber/types";
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
  it("maps binding mm to three units RAW (no lab↔three axis swap)", () => {
    const obj = new THREE.Object3D();
    // The binding pose lives in the parent CAD frame — the same frame as
    // the meshes it positions — so it's applied per-axis with NO y↔z
    // swap: x=10, y=20, z=30 → three (10/100, 20/100, 30/100). (This is
    // the fix for composites scattering: labMmToThree's swap put binding
    // positions in a different frame than their un-swapped meshes.)
    applyBindingLocalTransform(
      obj,
      makeNode("n", makeTransform({ xMm: 10, yMm: 20, zMm: 30 })),
    );
    expect(obj.position.x).toBeCloseTo(mmToThree(10));
    expect(obj.position.y).toBeCloseTo(mmToThree(20));
    expect(obj.position.z).toBeCloseTo(mmToThree(30));
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

  it("rz=90deg rotates +x to +y (90° about three Z, raw XYZ Euler)", () => {
    // Raw CAD-frame composition (matches ComponentsEditor.poseFromBinding):
    // binding rz → rotation about three Z, so +X (1,0,0) → +Y (0,1,0).
    const obj = new THREE.Object3D();
    applyBindingLocalTransform(obj, makeNode("n", makeTransform({ rzDeg: 90 })));
    const v = new THREE.Vector3(1, 0, 0);
    v.applyQuaternion(obj.quaternion);
    expect(v.x).toBeCloseTo(0, 5);
    expect(v.y).toBeCloseTo(1, 5);
    expect(v.z).toBeCloseTo(0, 5);
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

  it("nests child binding groups under their parent's binding pivot", async () => {
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
    expect(rootObj.children).toHaveLength(2);
    const childGroup = rootObj.children.find((c) => c.userData.__bindingChildrenOf === "root");
    expect(childGroup).toBeDefined();
    if (!childGroup) throw new Error("missing child binding group");
    expect(childGroup.children).toHaveLength(1);
    const childPivot = childGroup.children[0];
    expect(childPivot.name).toBe("child");
    // Local transform applied: x=25 mm → x=mmToThree(25) in three.
    expect(childPivot.position.x).toBeCloseTo(mmToThree(25));
  });

  it("tags every loaded object with its binding id for selection round-trip", async () => {
    const nodes: ResolvedBindingNode[] = [makeNode("the_root")];
    const loader = async () => new THREE.Group();
    const result = await buildBindingTreeObject(nodes, loader);
    expect(result.children[0].userData.__bindingId).toBe("the_root");
    expect(result.children[0].children[0].userData.__bindingId).toBe("the_root");
  });

  it("preserves loader-authored root rotations inside the binding pivot", async () => {
    const nodes: ResolvedBindingNode[] = [
      makeNode("glan", makeTransform({ rzDeg: 225 })),
    ];
    const loader = async () => {
      const g = new THREE.Group();
      g.rotation.set(0, 0, Math.PI / 2, "XYZ");
      return g;
    };
    const result = await buildBindingTreeObject(nodes, loader);
    const pivot = result.children[0];
    const content = pivot.children[0];

    const pivotDir = new THREE.Vector3(1, 0, 0).applyQuaternion(pivot.quaternion);
    const contentDir = new THREE.Vector3(1, 0, 0).applyQuaternion(content.quaternion);

    expect(pivotDir.x).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(pivotDir.y).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(contentDir.x).toBeCloseTo(0, 5);
    expect(contentDir.y).toBeCloseTo(1, 5);
  });
});

// ---------------------------------------------------------------------------
// Per-binding pigtails (properties.fiberNodes)
// ---------------------------------------------------------------------------


/** A binding carrying its own fibre run — the pigtail of a fibre-coupled
 *  instrument. A `fiber` patch cable keeps ONE spline on the Component /
 *  SceneObject, so a two-pigtail part (the EOSpace EOM) has nowhere to put
 *  the second; per-binding splines lift that limit. */
function withPigtail(
  node: ResolvedBindingNode,
  props: Record<string, unknown>,
): ResolvedBindingNode {
  return { ...node, binding: { ...node.binding, properties: props } };
}

const NODES_2 = [
  { posMm: [0, 0, 0] },
  { posMm: [100, 0, -20] },
];

function pigtailsOf(group: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.fiberRole === "pigtail") {
      found.push(o as THREE.Mesh);
    }
  });
  return found;
}

const stubLoader = async (node: ResolvedBindingNode) => {
  const g = new THREE.Group();
  g.name = node.binding.id;
  return g;
};


describe("per-binding pigtail", () => {
  it("renders a tube for a binding that declares fiberNodes", async () => {
    const node = withPigtail(makeNode("port"), { fiberNodes: NODES_2 });
    const result = await buildBindingTreeObject([node], stubLoader);
    const tubes = pigtailsOf(result);
    expect(tubes).toHaveLength(1);
    expect(tubes[0].name).toBe("port__pigtail");
    expect(tubes[0].userData.__bindingId).toBe("port");
  });

  it("renders nothing without at least two nodes", async () => {
    for (const props of [{}, { fiberNodes: [] }, { fiberNodes: [NODES_2[0]] }]) {
      const result = await buildBindingTreeObject(
        [withPigtail(makeNode("port"), props)], stubLoader,
      );
      expect(pigtailsOf(result)).toHaveLength(0);
    }
  });

  it("hangs the tube on the PARENT, not the binding pivot", async () => {
    // The nodes are in the parent's frame, so the binding's own local
    // transform must NOT be applied to them a second time.
    const node = withPigtail(
      makeNode("port", makeTransform({ xMm: 500, rzDeg: 90 })),
      { fiberNodes: NODES_2 },
    );
    const result = await buildBindingTreeObject([node], stubLoader);
    const tube = pigtailsOf(result)[0];
    expect(tube.parent).toBe(result);
    expect(tube.position.x).toBe(0);
    expect(tube.quaternion.x).toBe(0);
    expect(tube.quaternion.w).toBe(1);
  });

  it("lets ONE component carry several independent runs", async () => {
    const result = await buildBindingTreeObject([
      withPigtail(makeNode("in"), { fiberNodes: NODES_2 }),
      withPigtail(makeNode("out"), { fiberNodes: NODES_2 }),
      makeNode("body"),
    ], stubLoader);
    expect(pigtailsOf(result).map((t) => t.name).sort())
      .toEqual(["in__pigtail", "out__pigtail"]);
  });

  it("colours the jacket from the bound connector's fiberType", async () => {
    const pm = withPigtail(makeNode("pm"), { fiberNodes: NODES_2 });
    (pm.target as { kind: "asset"; asset: { defaultParams?: unknown } }).asset
      .defaultParams = { fiberType: "polarization_maintaining" };
    const sm = withPigtail(makeNode("sm"), { fiberNodes: NODES_2 });
    (sm.target as { kind: "asset"; asset: { defaultParams?: unknown } }).asset
      .defaultParams = { fiberType: "single_mode" };
    const result = await buildBindingTreeObject([pm, sm], stubLoader);
    const [tubePm, tubeSm] = pigtailsOf(result);
    const hex = (m: THREE.Mesh) =>
      "#" + (m.material as THREE.MeshStandardMaterial).color.getHexString();
    expect(hex(tubePm)).toBe("#1d4ed8");   // PM blue
    expect(hex(tubeSm)).toBe("#facc15");   // SM yellow
  });

  it("prefers the per-instance override over the binding baseline", async () => {
    // The binding row is the catalog baseline shared by every instance of
    // the part; how THIS one is dressed lives on the SceneObject. Same
    // layer split as SceneObject.properties.fiberNodes over
    // Component.properties.fiberNodes for a patch cable.
    const node = withPigtail(makeNode("port"), { fiberNodes: NODES_2 });
    const override: FiberNode[] = [{ posMm: [0, 0, 0] }, { posMm: [0, 0, 300] }];
    const result = await buildBindingTreeObject(
      [node], stubLoader, (id) => (id === "port" ? override : undefined),
    );
    const tube = pigtailsOf(result)[0];
    tube.geometry.computeBoundingBox();
    // The baseline run ends at x=100; the override runs up z instead.
    expect(tube.geometry.boundingBox!.max.z).toBeGreaterThan(2.0);
    expect(tube.geometry.boundingBox!.max.x).toBeLessThan(0.5);
  });

  it("ignores an override with fewer than two nodes", async () => {
    const node = withPigtail(makeNode("port"), { fiberNodes: NODES_2 });
    const result = await buildBindingTreeObject(
      [node], stubLoader, () => [{ posMm: [0, 0, 0] }] as FiberNode[],
    );
    const tube = pigtailsOf(result)[0];
    tube.geometry.computeBoundingBox();
    expect(tube.geometry.boundingBox!.max.x).toBeGreaterThan(0.5);   // baseline
  });

  it("exposes the resolved nodes on userData for the node-edit gizmo", async () => {
    const node = withPigtail(makeNode("port"), { fiberNodes: NODES_2, fiberRadiusMm: 1.4 });
    const override: FiberNode[] = [{ posMm: [0, 0, 0] }, { posMm: [0, 0, 300] }];
    const tube = pigtailsOf(await buildBindingTreeObject(
      [node], stubLoader, () => override,
    ))[0];
    expect(tube.userData.pigtailNodes).toEqual(override);
    expect(tube.userData.pigtailRadiusMm).toBe(1.4);
  });

  it("honours an explicit fiberJacketColor override", async () => {
    const node = withPigtail(makeNode("port"), {
      fiberNodes: NODES_2, fiberJacketColor: "#ff0000",
    });
    const tube = pigtailsOf(await buildBindingTreeObject([node], stubLoader))[0];
    expect("#" + (tube.material as THREE.MeshStandardMaterial).color.getHexString())
      .toBe("#ff0000");
  });
});
