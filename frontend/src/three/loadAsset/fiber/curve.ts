import * as THREE from "three";

import type { FiberEndPlacement, FiberNode } from "./types";

/** Lab (mm) → fiber-wrapper-local three units. Shared with rf_cable/. */
export const labMmToFiberThree = (p: [number, number, number]) =>
  new THREE.Vector3(p[0] / 100, p[2] / 100, -p[1] / 100);

export const offsetMmToFiberThree = (d: [number, number, number]) =>
  new THREE.Vector3(d[0] / 100, d[2] / 100, -d[1] / 100);

export function buildFiberCurvePath(nodes: FiberNode[]): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const segmentDelta: [number, number, number] = [
      b.posMm[0] - a.posMm[0],
      b.posMm[1] - a.posMm[1],
      b.posMm[2] - a.posMm[2],
    ];
    const defaultHandle: [number, number, number] = [
      segmentDelta[0] / 3,
      segmentDelta[1] / 3,
      segmentDelta[2] / 3,
    ];
    const aOut = a.handleOutMm ?? defaultHandle;
    const bIn = b.handleInMm ?? [-defaultHandle[0], -defaultHandle[1], -defaultHandle[2]];
    const p0 = labMmToFiberThree(a.posMm);
    const p3 = labMmToFiberThree(b.posMm);
    const p1 = p0.clone().add(offsetMmToFiberThree(aOut));
    const p2 = p3.clone().add(offsetMmToFiberThree(bIn));
    path.add(new THREE.CubicBezierCurve3(p0, p1, p2, p3));
  }
  return path;
}

/** OUTWARD direction (in three units, fiber-wrapper-local) at endpoint
 *  `endpoint` of the Bezier polyline `nodes` — the unit vector pointing
 *  AWAY from the curve body, used to orient the FC connector ferrule. For
 *  endpoint A this is `-handleOut` (the curve leaves A toward B in the
 *  +handleOut direction); for endpoint B it's `-handleIn`. Falls back to
 *  the segment direction toward the neighbour if the handle is missing
 *  or zero-length. */
export function fiberEndpointOutwardThree(
  nodes: FiberNode[],
  endpoint: "A" | "B",
): THREE.Vector3 {
  const idx = endpoint === "A" ? 0 : nodes.length - 1;
  const neighbourIdx = endpoint === "A" ? 1 : nodes.length - 2;
  const node = nodes[idx];
  const handle = endpoint === "A" ? node.handleOutMm : node.handleInMm;
  if (handle && handle[0] ** 2 + handle[1] ** 2 + handle[2] ** 2 > 1e-9) {
    return offsetMmToFiberThree([-handle[0], -handle[1], -handle[2]]).normalize();
  }
  const neighbour = nodes[neighbourIdx];
  const seg = labMmToFiberThree(node.posMm).clone().sub(labMmToFiberThree(neighbour.posMm));
  if (seg.lengthSq() < 1e-9) seg.set(1, 0, 0);
  return seg.normalize();
}

/** Re-orient and reposition a previously-built FC connector group to
 *  match the current node array. Used both at initial build (loadAsset)
 *  and live during drag (DigitalTwinViewer's rebuildTube), so the
 *  connector tracks anchor and tangent-handle changes in real time. */
export function applyFiberConnectorTransform(
  conn: THREE.Object3D,
  nodes: FiberNode[],
  endpoint: "A" | "B",
): void {
  const idx = endpoint === "A" ? 0 : nodes.length - 1;
  const outward = fiberEndpointOutwardThree(nodes, endpoint);
  conn.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
  conn.position.copy(labMmToFiberThree(nodes[idx].posMm));
}

/** Apply ferrule orientation derived from `tensionHandleMm` + a
 *  residual roll from `rotDeg`. The connector mesh is built so its
 *  local +Y points to the tip (away from the wire). For end A with
 *  tension = +X×10 (wire goes into body +X), the connector tip should
 *  point body -X.
 *
 *  Algorithm: rotate connector +Y to match `-unit(tension)` in body
 *  frame. Then apply only axial roll around the connector's local +Y.
 *  This keeps the ferrule head and the fiber line tangent coincident;
 *  arbitrary pitch/yaw from rotDeg would visibly detach the head from
 *  the cable direction.
 *
 *  Falls back to the raw EulerXYZ from rotDeg when tension is zero. */
export function applyFiberFerruleOrientation(
  target: THREE.Object3D,
  tensionHandleMm: [number, number, number],
  rotDeg: [number, number, number],
) {
  const mag = Math.hypot(tensionHandleMm[0], tensionHandleMm[1], tensionHandleMm[2]);
  if (mag < 1e-6) {
    applyEulerXYZQuat(target, rotDeg);
    return;
  }
  // tipDirBody = -unit(tension) in body frame.
  const tipBody = new THREE.Vector3(
    -tensionHandleMm[0] / mag,
    -tensionHandleMm[1] / mag,
    -tensionHandleMm[2] / mag,
  );
  // Convert body-direction to three-frame: body (x,y,z) → three (x, z, -y).
  const tipThree = new THREE.Vector3(tipBody.x, tipBody.z, -tipBody.y);
  // Rotate connector local +Y to the target direction.
  const alignQ = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    tipThree,
  );
  target.quaternion.copy(alignQ);
  target.rotateY(THREE.MathUtils.degToRad(rotDeg[1]));
}

/** Apply Euler XYZ rotation (degrees) to a Three.js Object3D's
 *  quaternion. Matches the convention in fiberBodyEndpointResolver and
 *  in the SceneObject pose math. */
export function applyEulerXYZQuat(target: THREE.Object3D, rotDeg: [number, number, number]) {
  const e = new THREE.Euler(
    THREE.MathUtils.degToRad(rotDeg[0]),
    THREE.MathUtils.degToRad(rotDeg[1]),
    THREE.MathUtils.degToRad(rotDeg[2]),
    "ZYX", // intrinsic R_z·R_y·R_x = THREE's "ZYX" extrinsic order
  );
  target.quaternion.setFromEuler(e);
}

// Re-export placement type for callers that already do `import { FiberEndPlacement } from "../fiber/curve"`.
export type { FiberEndPlacement };
