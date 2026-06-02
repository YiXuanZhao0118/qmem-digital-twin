/**
 * Programmable Pulse Generator mounting math.
 *
 * A PPG is conceptually a connector that plugs directly into another
 * instrument's coax port (switch ttl_in, AOM trigger_in, etc.) — there is
 * no visible cable between them. To realise that, the PPG body's lab pose
 * is computed at render time so its own `rf_out` anchor coincides with
 * the target instrument's anchor pose, with opposite-facing direction
 * (mating). The rf_cable that records the routing relationship is still
 * present for propagation / RF Link graph purposes but is hidden in the
 * 3D viewer.
 *
 * Frame conventions (see `optical/frames.ts`):
 *   - Body-local positions / directions on Asset3D anchors are Z-up mm.
 *   - Lab positions are Z-up mm.
 *   - The PPG wrapper renders UNDER `labRoot` (which carries the single
 *     Z-up→Y-up swap S), so this whole computation stays in the canonical
 *     Z-up lab frame: positions use `labMmToThreeLocal` (pure scale, no
 *     swap), directions use `labDirToThreeLocal`, and the object rotation
 *     M = `sceneObjectToQuaternion` is applied to Z-up offsets — matching
 *     how the renderer composes world = S·M·b. The returned pose is
 *     therefore labRoot-LOCAL (raw Z-up three units), ready to write to
 *     `wrapper.position` / `wrapper.quaternion` under labRoot.
 */
import * as THREE from "three";

import type { Anchor, Asset3D, ComponentItem, SceneData, SceneObject } from "../types/digitalTwin";
import {
  labDirToThreeLocal,
  labMmToThreeLocal,
  sceneObjectToQuaternion,
} from "../optical/frames";
import { anchorObjectLocalAxisY, anchorObjectLocalPos, anchorObjectLocalPrimaryDir } from "./anchorAccess";

type RfCableEndpoints = {
  A?: { targetObjectId: string; targetAnchorId: string; targetAnchorName: string };
  B?: { targetObjectId: string; targetAnchorId: string; targetAnchorName: string };
};

function anchorPosThree(anchor: Anchor, asset: Asset3D | null | undefined): THREE.Vector3 {
  // Asset anchors live in body frame — convert to object-local CAD frame
  // before treating as an offset from the SceneObject's pose. Raw Z-up
  // (labRoot supplies the swap), so M rotates it as a Z-up offset.
  const p = anchorObjectLocalPos(anchor, asset);
  return labMmToThreeLocal({ xMm: p.x, yMm: p.y, zMm: p.z });
}

function anchorDirThree(anchor: Anchor, asset: Asset3D | null | undefined): THREE.Vector3 {
  // axisX (Phase 9.1 primary direction) first; fall back to the legacy
  // directionBodyLocal only for pre-tri-axis anchors. Reading the legacy
  // field alone returned null for modern anchors (rf_out / ttl_in carry
  // axisXBodyLocal, not directionBodyLocal), silently defaulting both the
  // PPG and target directions to (1,0,0) → wrong mating, and the mount
  // flipping when the target's RZ changed.
  const d = anchorObjectLocalPrimaryDir(anchor, asset) ?? { x: 1, y: 0, z: 0 };
  return labDirToThreeLocal(d).normalize();
}

function findConnectingCable(scene: SceneData, ppgObjectId: string): {
  cable: SceneObject;
  peer: { targetObjectId: string; targetAnchorId: string; targetAnchorName: string };
} | null {
  const cablePeIds = new Set(
    scene.physicsElements
      .filter((pe) => pe.elementKind === "rf_cable")
      .map((pe) => pe.objectId),
  );
  for (const obj of scene.objects) {
    if (!cablePeIds.has(obj.id)) continue;
    const eps = ((obj.properties ?? {}) as { rfCableEndpoints?: RfCableEndpoints }).rfCableEndpoints;
    if (!eps) continue;
    if (eps.A?.targetObjectId === ppgObjectId && eps.B) {
      return { cable: obj, peer: eps.B };
    }
    if (eps.B?.targetObjectId === ppgObjectId && eps.A) {
      return { cable: obj, peer: eps.A };
    }
  }
  return null;
}

/** Lab-frame anchor pose (in three.js units / quaternion) for a given
 *  asset anchor on a given SceneObject. Position = object.pose ∘ anchor.body. */
function targetAnchorLabPose(
  targetObj: SceneObject,
  anchor: Anchor,
  targetAsset: Asset3D | null | undefined,
): { posThree: THREE.Vector3; dirThree: THREE.Vector3; axisYThree: THREE.Vector3 | null } {
  const targetThreePos = labMmToThreeLocal({
    xMm: targetObj.xMm,
    yMm: targetObj.yMm,
    zMm: targetObj.zMm,
  });
  const targetQuat = sceneObjectToQuaternion(targetObj);
  const posBodyThree = anchorPosThree(anchor, targetAsset);
  const dirBodyThree = anchorDirThree(anchor, targetAsset);
  const posLabThree = posBodyThree.clone().applyQuaternion(targetQuat).add(targetThreePos);
  const dirLabThree = dirBodyThree.clone().applyQuaternion(targetQuat).normalize();
  // Target anchor's axisY in lab — used to build a stable side basis for
  // any manual nudge so it co-moves with the instrument. Null when the
  // anchor doesn't declare axisY.
  const axisYBody = anchorObjectLocalAxisY(anchor, targetAsset);
  const axisYThree = axisYBody
    ? labDirToThreeLocal(axisYBody).applyQuaternion(targetQuat).normalize()
    : null;
  return { posThree: posLabThree, dirThree: dirLabThree, axisYThree };
}

/** Look up an anchor on the SceneObject's asset by id + display name (the
 *  same matching rule the propagation map + cable resolver use). */
function findAnchor(
  scene: SceneData,
  objectId: string,
  anchorId: string,
  anchorName: string,
): { obj: SceneObject; anchor: Anchor; asset: Asset3D } | null {
  const obj = scene.objects.find((o) => o.id === objectId);
  if (!obj) return null;
  const comp = scene.components.find((c) => c.id === obj.componentId);
  if (!comp || !comp.asset3dId) return null;
  const asset = scene.assets.find((a) => a.id === comp.asset3dId);
  if (!asset || !Array.isArray(asset.anchors)) return null;
  const anchor = asset.anchors.find(
    (a) => a.id === anchorId && (a.name ?? a.id) === anchorName,
  );
  if (!anchor) return null;
  return { obj, anchor, asset };
}

/** Resolve the PPG's own rf_out anchor from its asset. The body-local
 *  position + direction here, combined with the mating target's lab pose,
 *  drive the placement math below. */
function findPpgRfOutAnchor(
  ppgObject: SceneObject,
  ppgComponent: ComponentItem | undefined,
  ppgAsset: Asset3D | undefined,
): Anchor | null {
  void ppgObject;
  void ppgComponent;
  if (!ppgAsset || !Array.isArray(ppgAsset.anchors)) return null;
  return ppgAsset.anchors.find((a) => a.id === "rf_out") ?? null;
}

/**
 * Compute the PPG's body lab pose so its rf_out anchor lands exactly on
 * the target's anchor (matched in position) with anti-parallel direction
 * (matched in orientation — facing into the port). Returns
 * ``{ positionThree, quaternion }`` ready to write to ``wrapper.position``
 * and ``wrapper.quaternion``. Returns ``null`` when:
 *   - no rf_cable currently links this PPG to a peer port, OR
 *   - the peer's object / anchor can no longer be resolved, OR
 *   - the PPG's own asset does not declare an rf_out anchor.
 * Callers should fall back to the regular SceneObject pose when the
 * helper returns null so a transiently-orphan PPG still renders.
 */
export function computePpgMountedThreePose(
  scene: SceneData,
  ppgObject: SceneObject,
  ppgComponent: ComponentItem | undefined,
  ppgAsset: Asset3D | undefined,
): { positionThree: THREE.Vector3; quaternion: THREE.Quaternion } | null {
  const ppgAnchor = findPpgRfOutAnchor(ppgObject, ppgComponent, ppgAsset);
  if (!ppgAnchor) return null;

  const connection = findConnectingCable(scene, ppgObject.id);
  if (!connection) return null;

  const resolved = findAnchor(
    scene,
    connection.peer.targetObjectId,
    connection.peer.targetAnchorId,
    connection.peer.targetAnchorName,
  );
  if (!resolved) return null;

  const target = targetAnchorLabPose(resolved.obj, resolved.anchor, resolved.asset);
  // Mating: PPG.rf_out should face the OPPOSITE of the target port's
  // outward normal so the two coax connector faces meet.
  const matingDir = target.dirThree.clone().negate().normalize();

  const ppgAnchorBodyPos = anchorPosThree(ppgAnchor, ppgAsset);
  const ppgAnchorBodyDir = anchorDirThree(ppgAnchor, ppgAsset);

  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    ppgAnchorBodyDir,
    matingDir,
  );
  // Position: place the PPG body such that ``quaternion * anchorBodyPos +
  // bodyPos == targetAnchorLabPos``  → bodyPos = targetPos - q·anchorBodyPos.
  const rotatedAnchor = ppgAnchorBodyPos.clone().applyQuaternion(quaternion);
  const positionThree = target.posThree.clone().sub(rotatedAnchor);

  // Connector side basis with Z = mating axis. Y comes from the TARGET
  // anchor's axisY (projected off Z) so the perpendicular plane co-moves
  // with the instrument — a manual nudge then means the same thing at any
  // orientation. Falls back to an arbitrary perpendicular when axisY is
  // absent or parallel to Z.
  const zc = matingDir.clone().normalize();
  let yc: THREE.Vector3;
  if (target.axisYThree) {
    const proj = target.axisYThree.clone().sub(
      zc.clone().multiplyScalar(target.axisYThree.dot(zc)),
    );
    yc = proj.lengthSq() > 1e-12
      ? proj.normalize()
      : new THREE.Vector3().crossVectors(
          Math.abs(zc.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0),
          zc,
        ).normalize();
  } else {
    yc = new THREE.Vector3().crossVectors(
      Math.abs(zc.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0),
      zc,
    ).normalize();
  }
  const xc = new THREE.Vector3().crossVectors(yc, zc).normalize();

  // Manual nudge in the connector frame (mm). Cleared to 0 — re-add only if
  // a residual mesh offset remains after the stable-basis fix.
  const depthMm = 0, sideXMm = 0, sideYMm = 0;
  positionThree
    .add(zc.clone().multiplyScalar(depthMm / 100))
    .add(xc.multiplyScalar(sideXMm / 100))
    .add(yc.multiplyScalar(sideYMm / 100));
  return { positionThree, quaternion };
}
