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
 *   - Three.js render frame is Y-up; `labMmToThree` / `labToThreeVector`
 *     are the canonical mappings.
 */
import * as THREE from "three";

import type { Anchor, Asset3D, ComponentItem, SceneData, SceneObject } from "../types/digitalTwin";
import { labMmToThree, labToThreeVector, sceneObjectToQuaternion } from "../optical/frames";

type RfCableEndpoints = {
  A?: { targetObjectId: string; targetAnchorId: string; targetAnchorName: string };
  B?: { targetObjectId: string; targetAnchorId: string; targetAnchorName: string };
};

function anchorPosThree(anchor: Anchor): THREE.Vector3 {
  const p = anchor.positionMmBodyLocal;
  return labMmToThree({ xMm: p.x, yMm: p.y, zMm: p.z });
}

function anchorDirThree(anchor: Anchor): THREE.Vector3 {
  const d = anchor.directionBodyLocal ?? { x: 1, y: 0, z: 0 };
  return labToThreeVector([d.x, d.y, d.z]).normalize();
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
): { posThree: THREE.Vector3; dirThree: THREE.Vector3 } {
  const targetThreePos = labMmToThree({
    xMm: targetObj.xMm,
    yMm: targetObj.yMm,
    zMm: targetObj.zMm,
  });
  const targetQuat = sceneObjectToQuaternion(targetObj);
  const posBodyThree = anchorPosThree(anchor);
  const dirBodyThree = anchorDirThree(anchor);
  const posLabThree = posBodyThree.clone().applyQuaternion(targetQuat).add(targetThreePos);
  const dirLabThree = dirBodyThree.clone().applyQuaternion(targetQuat).normalize();
  return { posThree: posLabThree, dirThree: dirLabThree };
}

/** Look up an anchor on the SceneObject's asset by id + display name (the
 *  same matching rule the propagation map + cable resolver use). */
function findAnchor(
  scene: SceneData,
  objectId: string,
  anchorId: string,
  anchorName: string,
): { obj: SceneObject; anchor: Anchor } | null {
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
  return { obj, anchor };
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

  const target = targetAnchorLabPose(resolved.obj, resolved.anchor);
  // Mating: PPG.rf_out should face the OPPOSITE of the target port's
  // outward normal so the two coax connector faces meet.
  const matingDir = target.dirThree.clone().negate().normalize();

  const ppgAnchorBodyPos = anchorPosThree(ppgAnchor);
  const ppgAnchorBodyDir = anchorDirThree(ppgAnchor);

  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    ppgAnchorBodyDir,
    matingDir,
  );
  // Position: place the PPG body such that ``quaternion * anchorBodyPos +
  // bodyPos == targetAnchorLabPos``  → bodyPos = targetPos - q·anchorBodyPos.
  const rotatedAnchor = ppgAnchorBodyPos.clone().applyQuaternion(quaternion);
  const positionThree = target.posThree.clone().sub(rotatedAnchor);

  return { positionThree, quaternion };
}
