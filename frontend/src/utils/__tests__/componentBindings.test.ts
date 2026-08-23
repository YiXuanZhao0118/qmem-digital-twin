/**
 * Unit tests for the ComponentBinding tree resolver (Stage A').
 *
 * Covers the renderer contract: every Component's bindings + a
 * SceneObject's per-instance overrides resolve to a flat tree of
 * (target, localTransform, children) the renderer can walk without
 * re-querying the scene.
 */

import { describe, expect, it } from "vitest";

import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  SceneObject,
} from "../../types/digitalTwin";
import {
  anchorsInBindingTree,
  assetsInBindingTree,
  bindingsFor,
  childrenOf,
  findAnchorInBindingTree,
  primaryAsset,
  resolveBindingTree,
  rootBindingsOf,
} from "../componentBindings";


// ---------------------------------------------------------------------------
// Fixture builders — small helpers so each test stays focused on its assertion.
// ---------------------------------------------------------------------------


function asset(id: string, name = id): Asset3D {
  return {
    id,
    name,
    assetType: "stl",
    filePath: `files/stl/${name}.stl`,
    unit: "mm",
    scaleFactor: 1,
    anchors: [],
  };
}


function component(id: string, asset3dId: string | null = null): ComponentItem {
  return {
    id,
    name: `comp_${id}`,
    kindId: "none",
    asset3dId,
    properties: {},
    physicsCapabilities: [],
  };
}


function binding(partial: Partial<ComponentBinding> & {
  componentId: string;
}): ComponentBinding {
  return {
    id: partial.id ?? `b_${Math.random().toString(36).slice(2, 8)}`,
    componentId: partial.componentId,
    parentBindingId: partial.parentBindingId ?? null,
    targetKind: partial.targetKind ?? "asset",
    asset3dId: partial.asset3dId ?? null,
    subComponentId: partial.subComponentId ?? null,
    role: partial.role ?? "body",
    localXMm: partial.localXMm ?? 0,
    localYMm: partial.localYMm ?? 0,
    localZMm: partial.localZMm ?? 0,
    localRxDeg: partial.localRxDeg ?? 0,
    localRyDeg: partial.localRyDeg ?? 0,
    localRzDeg: partial.localRzDeg ?? 0,
    tunableAxes: partial.tunableAxes ?? {},
    sortOrder: partial.sortOrder ?? 0,
    properties: partial.properties ?? {},
  };
}


function sceneObject(componentId: string): SceneObject {
  return {
    id: "obj_1",
    name: "obj_1",
    componentId,
    xMm: 0,
    yMm: 0,
    zMm: 0,
    rxDeg: 0,
    ryDeg: 0,
    rzDeg: 0,
    visible: true,
    locked: false,
    properties: {},
  };
}


/** Build an ObjectBinding row (alembic 0076) for tests. Unspecified
 *  delta axes default to null = "no override". */
function objectBinding(
  objectId: string,
  componentBindingId: string,
  deltas: Partial<{
    xMm: number; yMm: number; zMm: number;
    rxDeg: number; ryDeg: number; rzDeg: number;
  }> = {},
) {
  return {
    id: `${objectId}__${componentBindingId}`,
    objectId,
    componentBindingId,
    localXMmDelta: deltas.xMm ?? null,
    localYMmDelta: deltas.yMm ?? null,
    localZMmDelta: deltas.zMm ?? null,
    localRxDegDelta: deltas.rxDeg ?? null,
    localRyDegDelta: deltas.ryDeg ?? null,
    localRzDegDelta: deltas.rzDeg ?? null,
    asset3dIdOverride: null,
    properties: {},
  };
}


// ---------------------------------------------------------------------------
// bindingsFor / rootBindingsOf / childrenOf
// ---------------------------------------------------------------------------


describe("bindingsFor / rootBindingsOf / childrenOf", () => {
  it("filters scene bindings by componentId", () => {
    const a = asset("a");
    const root = binding({ id: "r1", componentId: "c1", asset3dId: a.id });
    const other = binding({ id: "r2", componentId: "c2", asset3dId: a.id });
    const scene = { componentBindings: [root, other], assets: [a], components: [] };
    expect(bindingsFor("c1", scene).map((b) => b.id)).toEqual(["r1"]);
    expect(bindingsFor("c2", scene).map((b) => b.id)).toEqual(["r2"]);
  });

  it("rootBindingsOf returns only parent=null bindings", () => {
    const root = binding({ id: "r", componentId: "c1", asset3dId: "a" });
    const child = binding({
      id: "child",
      componentId: "c1",
      asset3dId: "a",
      parentBindingId: "r",
    });
    const scene = {
      componentBindings: [root, child],
      assets: [asset("a")],
      components: [],
    };
    expect(rootBindingsOf("c1", scene).map((b) => b.id)).toEqual(["r"]);
  });

  it("childrenOf returns direct children only", () => {
    const root = binding({ id: "r", componentId: "c1", asset3dId: "a" });
    const child = binding({
      id: "child",
      componentId: "c1",
      asset3dId: "a",
      parentBindingId: "r",
    });
    const grandchild = binding({
      id: "g",
      componentId: "c1",
      asset3dId: "a",
      parentBindingId: "child",
    });
    const scene = {
      componentBindings: [root, child, grandchild],
      assets: [asset("a")],
      components: [],
    };
    expect(childrenOf(root, scene).map((b) => b.id)).toEqual(["child"]);
    expect(childrenOf(child, scene).map((b) => b.id)).toEqual(["g"]);
  });
});


// ---------------------------------------------------------------------------
// primaryAsset (back-compat fast path)
// ---------------------------------------------------------------------------


describe("primaryAsset", () => {
  it("returns the single root binding's asset", () => {
    const a = asset("a");
    const c = component("c", null);
    const root = binding({ componentId: c.id, asset3dId: a.id });
    expect(
      primaryAsset(c, { componentBindings: [root], assets: [a] }),
    ).toBe(a);
  });

  it("falls back to component.asset3dId when no bindings exist (legacy)", () => {
    const a = asset("a");
    const c = component("c", a.id);
    expect(primaryAsset(c, { componentBindings: [], assets: [a] })).toBe(a);
  });

  it("returns null for composite trees (multiple roots)", () => {
    const a = asset("a");
    const b = asset("b");
    const c = component("c", null);
    const r1 = binding({ componentId: c.id, asset3dId: a.id });
    const r2 = binding({ componentId: c.id, asset3dId: b.id });
    expect(
      primaryAsset(c, { componentBindings: [r1, r2], assets: [a, b] }),
    ).toBeNull();
  });
});




// ---------------------------------------------------------------------------
// resolveBindingTree
// ---------------------------------------------------------------------------


describe("resolveBindingTree", () => {
  it("resolves a single-root asset binding (visual no-op for legacy)", () => {
    const a = asset("a");
    const c = component("c");
    const root = binding({ id: "r", componentId: c.id, asset3dId: a.id });
    const tree = resolveBindingTree(c, null, {
      componentBindings: [root],
      assets: [a],
      components: [c],
    });
    expect(tree).toHaveLength(1);
    expect(tree[0].binding.id).toBe("r");
    expect(tree[0].target).toEqual({ kind: "asset", asset: a });
    expect(tree[0].localTransform).toEqual({
      xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0,
    });
    expect(tree[0].children).toEqual([]);
  });

  it("applies scene.objectBindings deltas on top of the ComponentBinding baseline", () => {
    const a = asset("a");
    const c = component("c");
    const root = binding({
      id: "r",
      componentId: c.id,
      asset3dId: a.id,
      localXMm: 5,
      localRzDeg: 30,
    });
    const obj = sceneObject(c.id);
    const ob = objectBinding(obj.id, "r", { rzDeg: 1.7 });
    const tree = resolveBindingTree(c, obj, {
      componentBindings: [root],
      objectBindings: [ob],
      assets: [a],
      components: [c],
    });
    // xMm has no override row → keeps baseline 5.
    // rzDeg has delta 1.7 → effective = baseline 30 + delta 1.7 = 31.7.
    expect(tree[0].localTransform.xMm).toBe(5);
    expect(tree[0].localTransform.rzDeg).toBeCloseTo(31.7, 9);
  });

  it("walks a composite tree (Isolator pattern: body + 2 end caps + PBS sub-components)", () => {
    const faradayBody = asset("faraday_body");
    const endCap = asset("end_cap");
    const pbsAsset = asset("pbs_cube");
    const pbsComp = component("pbs", pbsAsset.id);
    const isolator = component("isolator");
    const root = binding({
      id: "root",
      componentId: isolator.id,
      asset3dId: faradayBody.id,
      role: "body",
    });
    const partA = binding({
      id: "partA",
      componentId: isolator.id,
      parentBindingId: "root",
      asset3dId: endCap.id,
      role: "mount",
      localZMm: 50,
    });
    const partB = binding({
      id: "partB",
      componentId: isolator.id,
      parentBindingId: "root",
      asset3dId: endCap.id,
      role: "mount",
      localZMm: -50,
    });
    const pbsA = binding({
      id: "pbsA",
      componentId: isolator.id,
      parentBindingId: "partA",
      targetKind: "subcomponent",
      subComponentId: pbsComp.id,
    });
    const pbsB = binding({
      id: "pbsB",
      componentId: isolator.id,
      parentBindingId: "partB",
      targetKind: "subcomponent",
      subComponentId: pbsComp.id,
    });
    // Sub-Component's own root binding (PBS body asset).
    const pbsRoot = binding({
      id: "pbsRoot",
      componentId: pbsComp.id,
      asset3dId: pbsAsset.id,
    });
    const scene = {
      componentBindings: [root, partA, partB, pbsA, pbsB, pbsRoot],
      assets: [faradayBody, endCap, pbsAsset],
      components: [isolator, pbsComp],
    };
    const tree = resolveBindingTree(isolator, null, scene);

    expect(tree).toHaveLength(1);
    const rootNode = tree[0];
    expect(rootNode.target).toEqual({ kind: "asset", asset: faradayBody });
    expect(rootNode.children.map((c) => c.binding.id)).toEqual(["partA", "partB"]);

    const partANode = rootNode.children[0];
    // partA's children = its own binding-children (PBS subcomp ref) PLUS
    // the PBS sub-Component's own root binding spliced in.
    expect(partANode.children.map((c) => c.binding.id)).toEqual([
      "pbsA",
      // pbsA's children include the PBS sub-Component's root binding.
    ]);
    const pbsANode = partANode.children[0];
    expect(pbsANode.target).toEqual({ kind: "subcomponent", component: pbsComp });
    expect(pbsANode.children.map((c) => c.binding.id)).toEqual(["pbsRoot"]);
    expect(pbsANode.children[0].target).toEqual({ kind: "asset", asset: pbsAsset });
  });

  it("emits target=missing when a binding points at an asset that's not in the scene", () => {
    const c = component("c");
    const root = binding({ componentId: c.id, asset3dId: "ghost_asset" });
    const tree = resolveBindingTree(c, null, {
      componentBindings: [root],
      assets: [],
      components: [c],
    });
    expect(tree[0].target).toEqual({ kind: "missing", reason: "asset" });
  });

  it("guards against subcomponent cycles via the visited set", () => {
    // A's binding points at B as sub-Component; B's binding points back at A.
    // Without the visited guard the walker would loop forever.
    const a = component("a");
    const b = component("b");
    const aRoot = binding({
      id: "a_root",
      componentId: a.id,
      targetKind: "subcomponent",
      subComponentId: b.id,
    });
    const bRoot = binding({
      id: "b_root",
      componentId: b.id,
      targetKind: "subcomponent",
      subComponentId: a.id,
    });
    const scene = {
      componentBindings: [aRoot, bRoot],
      assets: [],
      components: [a, b],
    };
    const tree = resolveBindingTree(a, null, scene);
    expect(tree).toHaveLength(1);
    // a_root's child is b_root (B's own root binding spliced in); b_root
    // tries to recurse into A, but A is already in the visited set →
    // the sub-Component splice is skipped, terminating the walk.
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].binding.id).toBe("b_root");
    expect(tree[0].children[0].children).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// assetsInBindingTree
// ---------------------------------------------------------------------------


describe("assetsInBindingTree", () => {
  it("returns every root asset of a multi-root Component, in order", () => {
    // The EOSpace EOM shape: modulator body + two FC/APC connectors, all
    // three sitting at root. primaryAsset gives up here; this must not.
    const body = asset("body");
    const conn = asset("conn");
    const c = component("c1");
    const scene = {
      componentBindings: [
        binding({ id: "b0", componentId: "c1", asset3dId: body.id, sortOrder: 0 }),
        binding({ id: "b1", componentId: "c1", asset3dId: conn.id, sortOrder: 1 }),
        binding({ id: "b2", componentId: "c1", asset3dId: conn.id, sortOrder: 2 }),
      ],
      assets: [body, conn],
      components: [c],
    };
    expect(primaryAsset(c, scene)).toBeNull();
    expect(assetsInBindingTree(c, scene).map((a) => a.id)).toEqual(["body", "conn"]);
  });

  it("descends into child bindings and sub-Components", () => {
    const body = asset("body");
    const child = asset("child");
    const subAsset = asset("sub_asset");
    const sub = component("c2");
    const c = component("c1");
    const scene = {
      componentBindings: [
        binding({ id: "b0", componentId: "c1", asset3dId: body.id }),
        binding({ id: "b1", componentId: "c1", parentBindingId: "b0", asset3dId: child.id }),
        binding({
          id: "b2",
          componentId: "c1",
          parentBindingId: "b0",
          targetKind: "subcomponent",
          subComponentId: sub.id,
        }),
        binding({ id: "b3", componentId: "c2", asset3dId: subAsset.id }),
      ],
      assets: [body, child, subAsset],
      components: [c, sub],
    };
    expect(assetsInBindingTree(c, scene).map((a) => a.id)).toEqual([
      "body",
      "child",
      "sub_asset",
    ]);
  });

  it("matches primaryAsset on the single-root common case", () => {
    const a = asset("a");
    const c = component("c1");
    const scene = {
      componentBindings: [binding({ id: "b0", componentId: "c1", asset3dId: a.id })],
      assets: [a],
      components: [c],
    };
    expect(assetsInBindingTree(c, scene)).toEqual([primaryAsset(c, scene)]);
  });

  it("falls back to the legacy component.asset3dId when there are no bindings", () => {
    const a = asset("a");
    const c = component("c1", a.id);
    const scene = { componentBindings: [], assets: [a], components: [c] };
    expect(assetsInBindingTree(c, scene).map((x) => x.id)).toEqual(["a"]);
  });

  it("returns [] when the Component has neither bindings nor a legacy asset", () => {
    const c = component("c1");
    expect(
      assetsInBindingTree(c, { componentBindings: [], assets: [], components: [c] }),
    ).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// findAnchorInBindingTree / anchorsInBindingTree
// ---------------------------------------------------------------------------


/** The EOSpace EOM shape that broke RF connect: the modulator body carries
 *  the `rf_in` port, and two identical FC/APC connector assets sit alongside
 *  it at root, so `primaryAsset` answers null and the port was invisible to
 *  every caller that went through it. */
function eomLikeScene() {
  const body = asset("body");
  body.anchors = [
    { id: "intercept_in", positionMmBodyLocal: { x: 0, y: 0, z: 0 } },
    { id: "rf_in", name: "RF IN", positionMmBodyLocal: { x: 40, y: 0, z: 13.5 } },
  ];
  const conn = asset("conn");
  conn.anchors = [
    { id: "connect_in", positionMmBodyLocal: { x: 0, y: 0, z: 0 } },
    { id: "connect_out", positionMmBodyLocal: { x: 5, y: 0, z: 0 } },
  ];
  const c = component("c1");
  const scene = {
    componentBindings: [
      binding({ id: "b0", componentId: "c1", asset3dId: body.id, sortOrder: 0 }),
      binding({ id: "b1", componentId: "c1", asset3dId: conn.id, sortOrder: 3 }),
      binding({ id: "b2", componentId: "c1", asset3dId: conn.id, sortOrder: 4 }),
    ],
    assets: [body, conn],
    components: [c],
  };
  return { body, conn, c, scene };
}


describe("findAnchorInBindingTree", () => {
  it("finds an anchor on a multi-root Component where primaryAsset gives up", () => {
    const { body, c, scene } = eomLikeScene();
    expect(primaryAsset(c, scene)).toBeNull();
    const owned = findAnchorInBindingTree(c, scene, "rf_in", "RF IN");
    expect(owned?.anchor.id).toBe("rf_in");
    expect(owned?.asset.id).toBe(body.id);
  });

  it("matches on the anchor id when the anchor has no name", () => {
    const { c, scene } = eomLikeScene();
    expect(findAnchorInBindingTree(c, scene, "connect_out", "connect_out")?.anchor.id)
      .toBe("connect_out");
  });

  it("returns null when the name doesn't match the stored one", () => {
    const { c, scene } = eomLikeScene();
    // "RFIN" is the panel's DISPLAY form; the stored identity is "RF IN".
    expect(findAnchorInBindingTree(c, scene, "rf_in", "RFIN")).toBeNull();
  });
});


describe("anchorsInBindingTree", () => {
  it("aggregates every root's anchors, deduped by anchorId|anchorName", () => {
    const { c, scene } = eomLikeScene();
    // The connector asset is bound twice — its two anchors appear once.
    expect(anchorsInBindingTree(c, scene).map(({ anchor: a }) => `${a.id}|${a.name ?? a.id}`))
      .toEqual([
        "intercept_in|intercept_in",
        "rf_in|RF IN",
        "connect_in|connect_in",
        "connect_out|connect_out",
      ]);
  });
});
