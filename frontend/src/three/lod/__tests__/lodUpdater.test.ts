/**
 * The per-frame LOD pass: distance measured to the AABB surface, the
 * selection pin, and the two budgets that keep it off the frame time.
 *
 * The AABB-surface case is the one that matters most — it is what makes the
 * rule work for an asset large enough to contain the camera, which a
 * centre-distance metric cannot express at all.
 */

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import type { AssetLod } from "../../../types/digitalTwin";
import { createLodNode, lodStateOf, setLodLevel } from "../lodNode";
import {
  LOD_EVAL_INTERVAL_MS,
  MAX_SWAPS_PER_PASS,
  createLodUpdaterState,
  updateSceneLod,
} from "../lodUpdater";

const TIERS: AssetLod[] = [
  { level: 0, filePath: "a.glb", triCount: 500, byteSize: 1, errorMm: 0 },
  { level: 2, filePath: "a.lod2.glb", triCount: 20, byteSize: 1, errorMm: 1.8 },
];

/** A node whose attached tier spans `sizeMm` about the origin. World units
 *  are mm/100, so the local box is built in those units. */
async function makeNode(objectId: string, sizeMm: number, startLevel: number) {
  const half = sizeMm / 100 / 2;
  const node = createLodNode(objectId, TIERS, async () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(half * 2, half * 2, half * 2)));
    return g;
  });
  node.userData.objectId = objectId;
  await setLodLevel(node, startLevel);
  return node;
}

function sceneWith(...nodes: THREE.Object3D[]): THREE.Object3D {
  const root = new THREE.Group();
  nodes.forEach((n) => root.add(n));
  root.updateMatrixWorld(true);
  return root;
}

function cameraAtMm(zMm: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
  camera.position.set(0, 0, zMm / 100);
  camera.updateMatrixWorld(true);
  return camera;
}

/** Run a pass with the throttle guaranteed open. */
function pass(
  root: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  options: Parameters<typeof updateSceneLod>[4] = {},
  state = createLodUpdaterState(),
) {
  return updateSceneLod(state, root, camera, 1080, options);
}

describe("updateSceneLod", () => {
  it("coarsens a distant object and refines a near one", async () => {
    const far = await makeNode("far", 50, 0);
    pass(sceneWith(far), cameraAtMm(8000));
    await Promise.resolve();
    expect(lodStateOf(far)!.level).toBe(2);

    const near = await makeNode("near", 50, 2);
    pass(sceneWith(near), cameraAtMm(300));
    await Promise.resolve();
    expect(lodStateOf(near)!.level).toBe(0);
  });

  // A 2 m asset seen from 30 cm above its surface: its CENTRE is a metre
  // away (which would happily pick LOD2), but its surface is right there.
  it("measures to the AABB surface, not the centre", async () => {
    const table = await makeNode("table", 2000, 2);
    // Camera 300 mm from the near face => 1300 mm from the centre.
    pass(sceneWith(table), cameraAtMm(1300));
    await Promise.resolve();
    expect(lodStateOf(table)!.level).toBe(0);

    // Same object, genuinely far away: now it may coarsen.
    const table2 = await makeNode("table2", 2000, 0);
    pass(sceneWith(table2), cameraAtMm(20000));
    await Promise.resolve();
    expect(lodStateOf(table2)!.level).toBe(2);
  });

  it("pins the selected object to full detail however far away it is", async () => {
    const node = await makeNode("sel", 50, 2);
    pass(sceneWith(node), cameraAtMm(50000), {
      pinnedObjectIds: new Set(["sel"]),
    });
    await Promise.resolve();
    expect(lodStateOf(node)!.level).toBe(0);
  });

  it("starts at most MAX_SWAPS_PER_PASS loads in one pass", async () => {
    const nodes = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => makeNode(`n${i}`, 50, 0)),
    );
    const swaps = pass(sceneWith(...nodes), cameraAtMm(8000));
    expect(swaps).toBe(MAX_SWAPS_PER_PASS);
  });

  it("throttles repeat passes inside the interval", async () => {
    const node = await makeNode("n", 50, 0);
    const root = sceneWith(node);
    const camera = cameraAtMm(8000);
    const state = createLodUpdaterState();

    expect(updateSceneLod(state, root, camera, 1080, { nowMs: 1000 })).toBe(1);
    // Same object, well inside the interval: no second evaluation.
    expect(
      updateSceneLod(state, root, camera, 1080, {
        nowMs: 1000 + LOD_EVAL_INTERVAL_MS / 2,
      }),
    ).toBe(0);
  });

  it("requests a redraw once a tier lands", async () => {
    const node = await makeNode("n", 50, 0);
    const onSwapApplied = vi.fn();
    pass(sceneWith(node), cameraAtMm(8000), { onSwapApplied });
    await Promise.resolve();
    await Promise.resolve();
    expect(onSwapApplied).toHaveBeenCalled();
  });

  it("ignores nodes whose bounds are not built yet", () => {
    const node = createLodNode("pending", TIERS, async () => new THREE.Group());
    expect(lodStateOf(node)!.localBounds).toBeNull();
    expect(pass(sceneWith(node), cameraAtMm(8000))).toBe(0);
  });
});
