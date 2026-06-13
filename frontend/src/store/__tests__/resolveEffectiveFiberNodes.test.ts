/**
 * Pinning tests for `resolveEffectiveFiberNodes` — the shared read that lets
 * every fiber-endpoint editor (Align A/B, port-pose editor, node count) work
 * for connector-component fibers, whose endpoints live ONLY on the fiber
 * PE's `kindParams.endA/endB` (no cached `properties.fiberNodes`).
 *
 * Invariants:
 *   - per-instance `SceneObject.properties.fiberNodes` (≥2) wins;
 *   - else catalog `Component.properties.fiberNodes` (≥2);
 *   - else reconstruct from the fiber PE's kindParams via
 *     `syncFiberNodesFromKindParams` (endpoints = kindParams, interior none);
 *   - undefined only when there is no cache AND no fiber PE kindParams.
 */

import { describe, expect, it } from "vitest";

import { resolveEffectiveFiberNodes } from "../sceneStore";

const OBJ = { id: "obj-1", properties: undefined as unknown };
const COMP = { properties: undefined as unknown };

function fiberPe(endA: unknown, endB: unknown) {
  return [
    { objectId: "obj-1", elementKind: "fiber", kindParams: { endA, endB } },
  ];
}

describe("resolveEffectiveFiberNodes", () => {
  it("prefers per-instance SceneObject.properties.fiberNodes", () => {
    const objNodes = [{ posMm: [1, 2, 3] }, { posMm: [4, 5, 6] }];
    const out = resolveEffectiveFiberNodes(
      { id: "obj-1", properties: { fiberNodes: objNodes } },
      { properties: { fiberNodes: [{ posMm: [9, 9, 9] }, { posMm: [8, 8, 8] }] } },
      fiberPe(null, null),
    );
    expect(out).toBe(objNodes);
  });

  it("falls back to Component.properties.fiberNodes when the object has none", () => {
    const compNodes = [{ posMm: [1, 0, 0] }, { posMm: [2, 0, 0] }];
    const out = resolveEffectiveFiberNodes(
      OBJ,
      { properties: { fiberNodes: compNodes } },
      [],
    );
    expect(out).toBe(compNodes);
  });

  it("reconstructs 2 endpoint nodes from PE.kindParams when caches are empty", () => {
    const out = resolveEffectiveFiberNodes(
      OBJ,
      COMP,
      fiberPe(
        { posMm: [10, 0, 0], tensionHandleMm: [5, 0, 0] },
        { posMm: [310, 0, 0], tensionHandleMm: [-5, 0, 0] },
      ),
    );
    expect(out).toBeDefined();
    expect(out).toHaveLength(2);
    expect(out![0].posMm).toEqual([10, 0, 0]);
    expect(out![0].handleOutMm).toEqual([5, 0, 0]);
    expect(out![out!.length - 1].posMm).toEqual([310, 0, 0]);
    expect(out![out!.length - 1].handleInMm).toEqual([-5, 0, 0]);
  });

  it("returns undefined when there is no cache and no fiber PE", () => {
    expect(resolveEffectiveFiberNodes(OBJ, COMP, [])).toBeUndefined();
  });

  it("returns undefined when the fiber PE has no endA/endB kindParams", () => {
    expect(
      resolveEffectiveFiberNodes(OBJ, COMP, fiberPe(null, null)),
    ).toBeUndefined();
  });

  it("returns undefined when obj is null (no SceneObject to key the PE)", () => {
    expect(
      resolveEffectiveFiberNodes(null, COMP, fiberPe({ posMm: [0, 0, 0] }, null)),
    ).toBeUndefined();
  });
});
