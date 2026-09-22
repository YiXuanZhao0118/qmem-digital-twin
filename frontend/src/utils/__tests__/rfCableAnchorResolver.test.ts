/**
 * `rfCableAnchorResolver.rfPortPoses` / `resolveRfPortPose` — which anchor an
 * RF link names, and where it is.
 *
 *   P1. Identity: the anchor an RfLink stores (`anchorId` + `name ?? id`) is
 *       found ANYWHERE in the binding tree — a multi-root Component (the
 *       EOSpace EOM: modulator + two FC/APC connectors) included, where
 *       `primaryAsset` gives up. First match in tree order; the display
 *       form of a name ("RFIN") is not the identity ("RF IN").
 *   P2. Pose: in the Component CAD frame THROUGH the binding chain (nested
 *       bindings, ObjectBinding deltas) — `anchorPose.resolveAnchorPosesLab`,
 *       the tracer's chain — not the anchor as stored in its asset.
 *   P3. Direction: axisX, else the legacy directionBodyLocal; none → the CAD
 *       frame's +X; a zero vector stays zero (degenerate), as the flows had.
 *   P4. A per-instance asset swap is honoured; one that removes the anchor
 *       leaves nothing to resolve (null).
 */
import { describe, expect, it } from "vitest";

import type { Anchor, SceneData, SceneObject } from "../../types/digitalTwin";
import { primaryAsset } from "../componentBindings";
import { resolveRfPortPose, rfPortPoses } from "../rfCableAnchorResolver";

type T3 = [number, number, number];

const anchor = (id: string, pos: T3, extra: Record<string, unknown> = {}): Anchor =>
  ({ id, positionMmBodyLocal: { x: pos[0], y: pos[1], z: pos[2] }, ...extra }) as unknown as Anchor;

const binding = (id: string, componentId: string, asset: string, o: { parent?: string; pos?: T3; rot?: T3; sort?: number } = {}) => ({
  id, componentId, parentBindingId: o.parent ?? null, targetKind: "asset", asset3dId: asset, subComponentId: null,
  role: id, sortOrder: o.sort ?? 0, properties: {}, tunableAxes: {},
  localXMm: o.pos?.[0] ?? 0, localYMm: o.pos?.[1] ?? 0, localZMm: o.pos?.[2] ?? 0,
  localRxDeg: o.rot?.[0] ?? 0, localRyDeg: o.rot?.[1] ?? 0, localRzDeg: o.rot?.[2] ?? 0,
});

const OBJ = { id: "o1", name: "O1", componentId: "c1", xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0 } as SceneObject;

/** The EOM shape: `rf_in` on the modulator body, two FC/APC connector
 *  roots alongside it. */
function eomScene(extra: Partial<Record<"objectBindings" | "assets", unknown[]>> = {}): SceneData {
  return {
    objects: [OBJ],
    components: [{ id: "c1", name: "EOM", kindId: "eom", asset3dId: null, properties: {} }],
    componentBindings: [
      binding("b0", "c1", "body"),
      binding("b1", "c1", "conn", { pos: [-80, 0, 0], sort: 3 }),
      binding("b2", "c1", "conn", { pos: [80, 0, 0], sort: 4 }),
    ],
    objectBindings: extra.objectBindings ?? [],
    assets: [
      { id: "body", name: "body", anchors: [
        anchor("intercept_in", [0, 0, 0], { axisXBodyLocal: { x: 1, y: 0, z: 0 } }),
        anchor("rf_in", [40, 0, 13.5], { name: "RF IN", axisXBodyLocal: { x: 0, y: 0, z: 1 } }),
      ] },
      { id: "conn", name: "conn", anchors: [
        anchor("connect_in", [0, 0, 0]),
        anchor("connect_out", [5, 0, 0]),
      ] },
      ...((extra.assets as never[]) ?? []),
    ],
    physicsElements: [],
  } as unknown as SceneData;
}

describe("resolveRfPortPose", () => {
  it("P1: finds a port on a multi-root Component where primaryAsset gives up", () => {
    const scene = eomScene();
    const c = scene.components[0];
    expect(primaryAsset(c, scene)).toBeNull();
    const p = resolveRfPortPose(c, OBJ, scene, "rf_in", "RF IN");
    expect(p?.asset.id).toBe("body");
    expect(p?.posCad).toEqual({ x: 40, y: 0, z: 13.5 });
  });

  it("P1: matches on the id when the anchor has no name; the display form is not the identity", () => {
    const scene = eomScene();
    const c = scene.components[0];
    expect(resolveRfPortPose(c, OBJ, scene, "connect_out", "connect_out")?.anchorId).toBe("connect_out");
    expect(resolveRfPortPose(c, OBJ, scene, "rf_in", "RFIN")).toBeNull();
  });

  it("P2: poses the port through a nested binding and an ObjectBinding delta", () => {
    // The connector root b1 at x −80, then an ObjectBinding delta of +10 mm
    // and a 90° turn about z: connect_out (5, 0, 0) lands at (−70, 5, 0).
    const scene = eomScene({
      objectBindings: [{
        id: "ob", objectId: "o1", componentBindingId: "b1", localXMmDelta: 10, localYMmDelta: null,
        localZMmDelta: null, localRxDegDelta: null, localRyDegDelta: null, localRzDegDelta: 90, asset3dIdOverride: null,
        properties: {},
      }],
    });
    const p = resolveRfPortPose(scene.components[0], OBJ, scene, "connect_out", "connect_out")!;
    expect(p.posCad.x).toBeCloseTo(-70, 12);
    expect(p.posCad.y).toBeCloseTo(5, 12);
    expect(p.posCad.z).toBeCloseTo(0, 12);
  });

  it("P3: axisX first, +X when none is declared, a zero vector stays degenerate", () => {
    const scene = eomScene();
    const c = scene.components[0];
    expect(resolveRfPortPose(c, OBJ, scene, "rf_in", "RF IN")!.dirCad).toEqual({ x: 0, y: 0, z: 1 });
    expect(resolveRfPortPose(c, OBJ, scene, "connect_in", "connect_in")!.dirCad).toEqual({ x: 1, y: 0, z: 0 });
    const zero = eomScene({ assets: [] });
    (zero.assets[0].anchors as Anchor[])[1] = anchor("rf_in", [40, 0, 13.5], { name: "RF IN", axisXBodyLocal: { x: 0, y: 0, z: 0 } });
    expect(resolveRfPortPose(zero.components[0], OBJ, zero, "rf_in", "RF IN")!.dirCad).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("P4: an asset swap is honoured, and one that removes the port leaves nothing", () => {
    const swapTo = (assetId: string) => eomScene({
      objectBindings: [{
        id: "ob", objectId: "o1", componentBindingId: "b0", localXMmDelta: null, localYMmDelta: null,
        localZMmDelta: null, localRxDegDelta: null, localRyDegDelta: null, localRzDegDelta: null,
        asset3dIdOverride: assetId, properties: {},
      }],
      assets: [
        { id: "body-alt", name: "body-alt", anchors: [anchor("rf_in", [10, 2, 3], { name: "RF IN", axisXBodyLocal: { x: 1, y: 0, z: 0 } })] },
        { id: "body-bare", name: "body-bare", anchors: [] },
      ],
    });
    const alt = swapTo("body-alt");
    expect(resolveRfPortPose(alt.components[0], OBJ, alt, "rf_in", "RF IN")?.posCad).toEqual({ x: 10, y: 2, z: 3 });
    const bare = swapTo("body-bare");
    expect(resolveRfPortPose(bare.components[0], OBJ, bare, "rf_in", "RF IN")).toBeNull();
    expect(rfPortPoses(bare.components[0], OBJ, bare).map((p) => p.anchorId)).toEqual(["connect_in", "connect_out"]);
  });
});
