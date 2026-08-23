/**
 * A fibre must be DRAWN where its endpoints are.
 *
 * `createFiberSplineObject` reads only `SceneObject.properties.fiberNodes`
 * then `Component.properties.fiberNodes`, and falls back to a hard-coded
 * 0→300 mm straight run when it finds neither. But a freshly instantiated
 * patch cable has its endpoints ONLY in the fibre PhysicsElement's
 * `kindParams.endA/endB` — nothing writes `properties.fiberNodes` until a
 * node is edited. The lab viewer therefore drew every un-edited cable at
 * the origin instead of at its real position (observed 2026-08-21: a cable
 * whose ends were at x −659…−890 rendered at 0…300, a metre away), while
 * the PHY Editor COMPONENT preview looked correct because it deliberately
 * draws the catalog shape.
 *
 * `buildSceneObjectFromBindings` now rebuilds from the PE, mirroring
 * `sceneStore.resolveEffectiveFiberNodes` — the precedence every fibre
 * endpoint EDITOR already used.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildSceneObjectFromBindings } from "../bindingRendererGate";
import type {
  ComponentItem,
  SceneData,
  SceneObject,
} from "../../types/digitalTwin";


const FIBER_COMPONENT = {
  id: "fiber_comp",
  name: "Fiber PM APC",
  kindId: "fiber",
  properties: {},
} as unknown as ComponentItem;

const OBJECT = {
  id: "fiber_obj",
  name: "FIBER_X",
  componentId: "fiber_comp",
  xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0,
  visible: true,
  properties: {},
} as unknown as SceneObject;

/** Endpoints as Align End A / B writes them: junction posMm + the outward
 *  tension handle. Deliberately far from the origin so a fallback spline is
 *  unmistakable. */
const PE = {
  objectId: "fiber_obj",
  elementKind: "fiber",
  kindParams: {
    endA: { posMm: [-659.333, 0, 0], tensionHandleMm: [-30, 0, 0] },
    endB: { posMm: [-890.167, 0, 0], tensionHandleMm: [30, 0, 0] },
  },
};

function sceneWith(physicsElements: unknown[]) {
  return {
    components: [FIBER_COMPONENT],
    componentBindings: [],
    objectBindings: [],
    assets: [],
    physicsElements,
  } as unknown as Pick<
    SceneData, "componentBindings" | "objectBindings" | "assets" | "components"
  > & { physicsElements?: SceneData["physicsElements"] };
}

/** Lab-mm span of the jacket tube. Viewer units are mm/100. */
async function tubeSpanMm(
  object: SceneObject,
  scene: ReturnType<typeof sceneWith>,
  component: ComponentItem = FIBER_COMPONENT,
): Promise<[number, number] | null> {
  const group = await buildSceneObjectFromBindings(component, object, scene);
  group.updateMatrixWorld(true);
  let span: [number, number] | null = null;
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.userData?.fiberRole !== "tube") return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    span = [Math.round(bb.min.x * 100), Math.round(bb.max.x * 100)];
  });
  return span;
}


describe("fibre spline in the lab renderer", () => {
  it("draws an un-cached cable at its PhysicsElement endpoints", async () => {
    const span = await tubeSpanMm(OBJECT, sceneWith([PE]));
    expect(span).not.toBeNull();
    const [min, max] = span!;
    // The endpoints, not the 0→300 fallback.
    expect(min).toBeGreaterThan(-900);
    expect(max).toBeLessThan(-650);
  });

  it("still prefers a cached per-instance spline over the endpoints", async () => {
    const cached = {
      ...OBJECT,
      properties: {
        fiberNodes: [{ posMm: [0, 0, 0] }, { posMm: [120, 0, 0] }],
      },
    } as unknown as SceneObject;
    const span = await tubeSpanMm(cached, sceneWith([PE]));
    expect(span![0]).toBe(0);
    expect(span![1]).toBe(120);
  });

  it("prefers the catalog spline over the endpoints (the documented order)", async () => {
    const comp = {
      ...FIBER_COMPONENT,
      properties: { fiberNodes: [{ posMm: [0, 0, 0] }, { posMm: [77, 0, 0] }] },
    } as unknown as ComponentItem;
    const span = await tubeSpanMm(OBJECT, sceneWith([PE]), comp);
    expect(span![1]).toBe(77);
  });

  it("falls back to the default run when there is no endpoint source at all", async () => {
    const span = await tubeSpanMm(OBJECT, sceneWith([]));
    expect(span).toEqual([0, 300]);
  });

  it("ignores a PhysicsElement belonging to another object", async () => {
    const other = { ...PE, objectId: "someone_else" };
    const span = await tubeSpanMm(OBJECT, sceneWith([other]));
    expect(span).toEqual([0, 300]);
  });
});
