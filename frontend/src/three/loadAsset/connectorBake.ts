/**
 * Bake a connector mesh into the cable placement frame, deterministically,
 * from its connect_out / connect_in anchors.
 *
 * A connector model can be authored in any orientation. The two anchors pin
 * the frame: connect_out = the cable-side junction, connect_in = the mating
 * tip. We put connect_out at the origin and align the connect_out→connect_in
 * axis to `targetAxis` — +X for RF (cable_spline rotates local +X onto the
 * endpoint tangent) or +Y for fibre (applyFiberFerruleOrientation rotates
 * local +Y onto the outward tangent). Then mm → scene scale.
 *
 * Falls back to a longest-bbox-axis heuristic when the anchors are missing
 * (e.g. a placeholder asset), so callers never have to special-case.
 */
import * as THREE from "three";

import { mmToThree } from "../transformUtils";

export type Vec3Mm = { x: number; y: number; z: number };

export function bakeConnectorByAnchors(
  geom: THREE.BufferGeometry,
  connectOut: Vec3Mm | null | undefined,
  connectIn: Vec3Mm | null | undefined,
  targetAxis: THREE.Vector3,
): THREE.BufferGeometry {
  if (connectOut && connectIn) {
    const co = new THREE.Vector3(connectOut.x, connectOut.y, connectOut.z);
    const ci = new THREE.Vector3(connectIn.x, connectIn.y, connectIn.z);
    const dir = ci.clone().sub(co);
    if (dir.lengthSq() > 1e-9) {
      dir.normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(dir, targetAxis);
      geom.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
      const coRot = co.applyQuaternion(q); // connect_out after the same rotation
      geom.translate(-coRot.x, -coRot.y, -coRot.z); // connect_out → origin (mm)
      geom.scale(mmToThree(1), mmToThree(1), mmToThree(1)); // mm → scene units
      return geom;
    }
  }

  // Fallback: longest bbox axis → targetAxis, near end → origin.
  geom.scale(mmToThree(1), mmToThree(1), mmToThree(1));
  geom.computeBoundingBox();
  const size = new THREE.Vector3();
  geom.boundingBox!.getSize(size);
  const toX = targetAxis.x === 1;
  if (toX) {
    if (size.y >= size.x && size.y >= size.z) geom.rotateZ(Math.PI / 2);
    else if (size.z >= size.x && size.z >= size.y) geom.rotateY(Math.PI / 2);
  } else {
    if (size.x >= size.y && size.x >= size.z) geom.rotateZ(Math.PI / 2);
    else if (size.z >= size.x && size.z >= size.y) geom.rotateX(-Math.PI / 2);
  }
  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  if (toX) {
    geom.translate(-bb.min.x, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);
  } else {
    geom.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  }
  return geom;
}
