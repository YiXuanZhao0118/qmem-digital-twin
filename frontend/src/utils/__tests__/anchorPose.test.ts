/**
 * `anchorPose.resolveAnchorPosesLab` agrees with the backend tracer.
 *
 * This is the load-bearing pin under every pose the app solves: the walk
 * composes the binding's raw THREE XYZ Euler (asset body → Component CAD)
 * with the SceneObject's YXZ-remapped convention (Component CAD → lab), and
 * getting that composition wrong puts every solved pose somewhere the ray
 * tracer disagrees with. The numbers below are BACKEND outputs from the live
 * scene, so reproducing them here pins the frontend against the authority.
 *
 * It used to live in `utils/__tests__/mirrorCoupling.test.ts`. That file went
 * when `utils/mirrorCoupling.ts` did (the web app calls
 * `POST /api/v3/align/mirror-coupling` now, see `api/align.ts`), but
 * `anchorPose.ts` stayed — it is what the align panels, the RF cable
 * resolver, the mode-matching panel and the store all read anchor poses with,
 * and what `backend/app/optical/align/anchor_poses.py` is the twin of.
 * The solver-side of the old file is pinned instead by
 * `backend/tests/fixtures/align/*.json` (frozen goldens) +
 * `backend/tests/optical/test_align_parity.py`.
 */
import { describe, expect, it } from "vitest";

import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  SceneData,
  SceneObject,
} from "../../types/digitalTwin";
import { resolveAnchorPosesLab } from "../anchorPose";

type Vec3 = { x: number; y: number; z: number };

// ─── fixtures: a BB1-E03-shaped mirror ─────────────────────────────────────
//
// Matches the live catalog row: one asset whose `intercept_face` sits at the
// asset origin with axisX = +Z, bound into the Component with localRx = -90
// (so the face normal is +Y in the Component CAD frame, which is what the
// mirror Component's alignSpec.directionMm records).

function mirrorAsset(id = "asset-mirror"): Asset3D {
  return {
    id,
    name: "BB1-E03-Step",
    kindId: "mirror",
    filePath: "bb1_e03_step.glb",
    anchors: [
      {
        id: "intercept_face",
        positionMmBodyLocal: { x: 0, y: 0, z: 0 },
        axisXBodyLocal: { x: 0, y: 0, z: 1 },
        axisYBodyLocal: { x: 0, y: 1, z: 0 },
        axisZBodyLocal: { x: -1, y: 0, z: 0 },
        apertureMm: 12.7,
        apertureShape: "circle",
      },
    ],
  } as unknown as Asset3D;
}

function mirrorScene(objects: SceneObject[]): Pick<
  SceneData,
  "componentBindings" | "objectBindings" | "assets" | "components"
> & { objects: SceneObject[] } {
  const component = {
    id: "comp-mirror",
    name: "Opt Mirror",
    kindId: "mirror",
    asset3dId: null,
  } as unknown as ComponentItem;
  const binding = {
    id: "bind-mirror",
    componentId: "comp-mirror",
    parentBindingId: null,
    targetKind: "asset",
    asset3dId: "asset-mirror",
    subComponentId: null,
    role: "BB1-E03-Step",
    localXMm: 0,
    localYMm: 0,
    localZMm: 0,
    localRxDeg: -90,
    localRyDeg: 0,
    localRzDeg: 0,
    sortOrder: 0,
  } as unknown as ComponentBinding;
  return {
    components: [component],
    assets: [mirrorAsset()],
    componentBindings: [binding],
    objectBindings: [],
    objects,
  };
}

function mirrorObject(id: string, pose: Partial<SceneObject>): SceneObject {
  return {
    id,
    name: id,
    componentId: "comp-mirror",
    xMm: 0,
    yMm: 0,
    zMm: 0,
    rxDeg: 0,
    ryDeg: 0,
    rzDeg: 0,
    locked: false,
    visible: true,
    properties: {},
    ...pose,
  } as unknown as SceneObject;
}

/** The reflective face's lab pose, the way every caller reads it. */
function face(id: string, pose: Partial<SceneObject>): {
  posLab: Vec3;
  normalLab: Vec3;
  apertureMm: number | null;
} {
  const obj = mirrorObject(id, pose);
  const scene = mirrorScene([obj]);
  const component = scene.components[0];
  const hit = resolveAnchorPosesLab(component, obj, scene)
    .find((a) => a.anchorId === "intercept_face");
  if (!hit || !hit.axisXLab) throw new Error(`${id}: no intercept_face with a direction`);
  return { posLab: hit.posLab, normalLab: hit.axisXLab, apertureMm: hit.apertureMm };
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
/** Ideal reflection off a plane with unit normal `n`. */
const reflect = (d: Vec3, n: Vec3): Vec3 => {
  const k = 2 * dot(d, n);
  return { x: d.x - n.x * k, y: d.y - n.y * k, z: d.z - n.z * k };
};

// ─── the backend agreement pin ─────────────────────────────────────────────

describe("anchorPose agrees with the backend tracer", () => {
  /**
   * MIRROR5 from the live scene. `/api/v3/solver/run-from-db` reports the
   * beam arriving along +X and leaving along -Y, crossing the mirror at
   * (-298.93, -453.52, 908.83). Both the crossing point and the reflected
   * direction are backend outputs, so reproducing them here pins the whole
   * frontend composition: the binding's raw XYZ Euler AND the SceneObject's
   * YXZ-remapped rotation convention.
   */
  it("reproduces MIRROR5's traced face centre and reflection", () => {
    const f = face("MIRROR5", {
      xMm: -298.926606,
      yMm: -453.518962,
      zMm: 908.83165,
      rxDeg: 135,
      ryDeg: -90,
      rzDeg: 0,
    });

    expect(f.posLab.x).toBeCloseTo(-298.93, 2);
    expect(f.posLab.y).toBeCloseTo(-453.52, 2);
    expect(f.posLab.z).toBeCloseTo(908.83, 2);
    expect(f.apertureMm).toBe(12.7);

    const out = reflect(v(1, 0, 0), f.normalLab);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(-1, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });

  it("reproduces MIRROR7 and MIRROR8's 45 deg normals", () => {
    const m7 = face("MIRROR7", {
      xMm: -297.414177, yMm: -489.149399, zMm: 909.760341,
      rxDeg: -45, ryDeg: -90, rzDeg: 0,
    });
    const m8 = face("MIRROR8", {
      xMm: -261.018145, yMm: -487.429769, zMm: 908.83165,
      rxDeg: 45, ryDeg: -90, rzDeg: 0,
    });
    // -Y in, +X out at MIRROR7; +X in, +Y out at MIRROR8.
    const afterM7 = reflect(v(0, -1, 0), m7.normalLab);
    expect(afterM7.x).toBeCloseTo(1, 9);
    const afterM8 = reflect(v(1, 0, 0), m8.normalLab);
    expect(afterM8.y).toBeCloseTo(1, 9);
  });
});
