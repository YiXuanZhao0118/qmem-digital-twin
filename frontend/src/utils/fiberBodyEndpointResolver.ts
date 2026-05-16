// Fiber body endpoint resolver — parallels rfCableAnchorResolver.ts.
//
// Phase fiber-split: a fiber body's two spline endpoints (nodes [0] and
// [N-1]) are no longer authoritative storage. The two paired fiber_end
// SceneObjects (referenced via FiberParams.endAObjectId / endBObjectId)
// own those endpoints — their lab pose drives where the spline meets
// each ferrule. Interior nodes [1..N-2] stay user-editable on the body
// SceneObject's properties.fiberNodes; this resolver re-derives the two
// endpoint nodes at render time.
//
// Conventions (chosen so the Phase B migration's identity-rotation
// placement stays visually consistent with pre-split data):
//
//   * fiber_end SceneObject's origin = "back" of the ferrule, i.e. the
//     point where the fiber jacket physically meets the ferrule. Thus
//     `fiber_end.lab_pose` = spline endpoint lab position directly.
//
//   * `tip` anchor body-local convention = (0, +TIP_OFFSET_MM, 0) along
//     +Y. With identity SceneObject rotation, "outward" (the direction
//     the light exits — pointing away from the cable body) is +Y in lab.
//     Rotating the SceneObject rotates this outward direction.
//
//   * Spline endpoint outward (= where the curve enters the ferrule,
//     opposite of the curve tangent at that node) = fiber_end's `tip`
//     lab direction.
//
// If `endA/BObjectId` is null on the fiber kindParams (legacy
// pre-migration data), the helper returns null so the caller falls back
// to the stored `fiberNodes[0]` / `fiberNodes[N-1]` from the body's
// `properties.fiberNodes`.

import type { SceneObject } from "../types/digitalTwin";

export type FiberBodyEndpointResolved = {
  /** Spline-endpoint position in the fiber BODY's local frame. Caller
   *  overwrites `fiberNodes[endpointIdx].posMm` with this. */
  posMmBody: [number, number, number];
  /** Bezier tangent handle, body-local. For end A: handleOut (curve
   *  going away from node 0 into the body interior). For end B:
   *  handleIn (curve coming into node N-1 from the interior). Same
   *  magnitude convention as rf_cable resolver (30 mm by default). */
  handleMmBody: [number, number, number];
};

type Pose = {
  xMm: number; yMm: number; zMm: number;
  rxDeg: number; ryDeg: number; rzDeg: number;
};

type Vec3T = [number, number, number];

/** Body-local convention for the fiber_end's tip anchor. Used until a
 *  proper Asset3D ferrule lands. Tip is at +Y · `FIBER_END_TIP_MM` from
 *  the SceneObject origin (= jacket attachment); outward = +Y. */
export const FIBER_END_TIP_OFFSET_MM = 36.0;
export const FIBER_END_DEFAULT_OUTWARD_BODY: Vec3T = [0, 1, 0];

/** Default Bezier tangent length applied to the resolved endpoint
 *  handle. Matches rfCableAnchorResolver's default so cable and fiber
 *  feel similar to drag. */
const HANDLE_MAGNITUDE_MM = 30.0;

function makePoseTransforms(pose: Pose) {
  const rxr = (pose.rxDeg * Math.PI) / 180;
  const ryr = (pose.ryDeg * Math.PI) / 180;
  const rzr = (pose.rzDeg * Math.PI) / 180;
  const cx = Math.cos(rxr), sxr = Math.sin(rxr);
  const cy = Math.cos(ryr), syr = Math.sin(ryr);
  const cz = Math.cos(rzr), szr = Math.sin(rzr);
  const bodyToLab = (v: Vec3T): Vec3T => {
    const x1 = cy * v[0] + syr * v[2];
    const y1 = v[1];
    const z1 = -syr * v[0] + cy * v[2];
    const y2 = cx * y1 - sxr * z1;
    const z2 = sxr * y1 + cx * z1;
    return [pose.xMm + cz * x1 - szr * y2, pose.yMm + szr * x1 + cz * y2, pose.zMm + z2];
  };
  const bodyToLabDir = (v: Vec3T): Vec3T => {
    const x1 = cy * v[0] + syr * v[2];
    const y1 = v[1];
    const z1 = -syr * v[0] + cy * v[2];
    const y2 = cx * y1 - sxr * z1;
    const z2 = sxr * y1 + cx * z1;
    return [cz * x1 - szr * y2, szr * x1 + cz * y2, z2];
  };
  const labToBody = (v: Vec3T): Vec3T => {
    const dx = v[0] - pose.xMm, dy = v[1] - pose.yMm, dz = v[2] - pose.zMm;
    const x2 = cz * dx + szr * dy;
    const y2 = -szr * dx + cz * dy;
    const z2 = dz;
    const y1 = cx * y2 + sxr * z2;
    const z1 = -sxr * y2 + cx * z2;
    return [cy * x2 - syr * z1, y1, syr * x2 + cy * z1];
  };
  const labToBodyDir = (v: Vec3T): Vec3T => {
    const x2 = cz * v[0] + szr * v[1];
    const y2 = -szr * v[0] + cz * v[1];
    const z2 = v[2];
    const y1 = cx * y2 + sxr * z2;
    const z1 = -sxr * y2 + cx * z2;
    return [cy * x2 - syr * z1, y1, syr * x2 + cy * z1];
  };
  return { bodyToLab, bodyToLabDir, labToBody, labToBodyDir };
}

function poseOf(obj: SceneObject): Pose {
  return {
    xMm: obj.xMm,
    yMm: obj.yMm,
    zMm: obj.zMm,
    rxDeg: obj.rxDeg,
    ryDeg: obj.ryDeg,
    rzDeg: obj.rzDeg,
  };
}

/** Resolve one spline endpoint from a paired fiber_end SceneObject.
 *  Returns the body-local position + handle for the node at index 0
 *  (end A) or N-1 (end B). When `fiberEnd` is undefined or null,
 *  returns null and the caller should keep the stored node value.
 */
export function resolveLinkedFiberEndpoint(args: {
  endpoint: "A" | "B";
  fiberBody: SceneObject;
  fiberEnd: SceneObject;
}): FiberBodyEndpointResolved | null {
  const { endpoint, fiberBody, fiberEnd } = args;
  const bodyT = makePoseTransforms(poseOf(fiberBody));
  const endT = makePoseTransforms(poseOf(fiberEnd));

  // Spline endpoint sits at the fiber_end's origin (jacket attachment).
  const endLab = endT.bodyToLab([0, 0, 0]);
  // Outward direction = fiber_end's tip-anchor lab direction.
  const outwardLab = endT.bodyToLabDir(FIBER_END_DEFAULT_OUTWARD_BODY);
  const mag = Math.hypot(outwardLab[0], outwardLab[1], outwardLab[2]);
  if (mag < 1e-9) return null;
  const outwardUnit: Vec3T = [
    outwardLab[0] / mag, outwardLab[1] / mag, outwardLab[2] / mag,
  ];
  // Bezier handle at the spline endpoint points INTO the spline body
  // (opposite of outward), so the curve smoothly meets the ferrule
  // axis. Magnitude defaults to HANDLE_MAGNITUDE_MM; future iterations
  // can carry the user's previous handle magnitude through.
  const handleLab: Vec3T = [
    -outwardUnit[0] * HANDLE_MAGNITUDE_MM,
    -outwardUnit[1] * HANDLE_MAGNITUDE_MM,
    -outwardUnit[2] * HANDLE_MAGNITUDE_MM,
  ];
  const posMmBody = bodyT.labToBody(endLab);
  // labToBodyDir applies only the inverse rotation, no translation —
  // exactly what we want for a direction vector.
  const handleMmBody = bodyT.labToBodyDir(handleLab);
  // The endpoint discriminator is consumed by the caller (which slot
  // to overwrite); we just return the pair.
  void endpoint;
  return { posMmBody, handleMmBody };
}
