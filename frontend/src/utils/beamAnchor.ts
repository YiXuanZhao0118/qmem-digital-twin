// Beam anchor: which point on a component physically sits ON the beam.
//
// For most components (lasers, lenses, mounts, AOMs, etc.) the beam goes
// through the body center — i.e. the object's xform origin. For mirrors,
// it's the REFLECTIVE FACE CENTER — slightly offset from body center along
// the mirror's local-frame normal.
//
// Resolution order:
//  1. Asset3D.anchors[] entry with id == "optical_anchor"      (per-asset)
//  2. Per-element-kind default                                  (kind-based)
//  3. Body center (no offset)                                   (final fallback)

import type { PhysicsElement, Asset3D, ComponentItem, SceneObject } from "../types/digitalTwin";
import { rotateLocalToLab, type Vec3 } from "./beamPlacement";
import { getMirrorNormalBodyLocal } from "./v2Bindings";

export const OPTICAL_ANCHOR_ID = "optical_anchor";

export type BeamAnchor = {
  /** Local-frame offset from object xform origin → anchor point (mm). */
  offsetLocalMm: Vec3;
  /** Local-frame outward unit normal — only meaningful for mirrors. Used
   *  by the aperture check to compute angle of incidence. */
  normalLocal: Vec3 | null;
  /** Where this anchor came from, for UI debug/explanation. */
  source: "asset_anchor" | "kind_default_mirror" | "kind_default_body";
};

/** Default mirror thickness when the asset doesn't carry one. The reflective
 *  face is assumed to sit `thickness/2` in front of body center along the
 *  local +Z axis (which is the conventional mirror normal). */
const DEFAULT_MIRROR_THICKNESS_MM = 6;

type SceneObjectLike = {
  id: string;
  componentId: string;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
  // V2 Phase 2: anchorBindings[opticalSurface] now carries the mirror normal.
  properties?: SceneObject["properties"];
};

/** Pick the right BeamAnchor for an OBJECT given the scene. The asset
 *  contributes geometry (anchor offset / normal); the OE contributes kind
 *  defaults (mirror gets reflective-face semantics). Per-object means
 *  each instance can have independent params even if they share an asset. */
export function getBeamAnchor(
  objectId: string,
  scene: { components: ComponentItem[]; assets: Asset3D[]; physicsElements: PhysicsElement[]; objects: SceneObjectLike[] },
): BeamAnchor {
  const obj = scene.objects.find((o) => o.id === objectId);
  const comp = obj ? scene.components.find((c) => c.id === obj.componentId) : null;
  const asset = comp?.asset3dId ? scene.assets.find((a) => a.id === comp.asset3dId) : null;
  const el = scene.physicsElements.find((e) => e.objectId === objectId);

  // 1. Per-asset declared anchor wins — explicit metadata authored by the
  //    asset importer always trumps kind defaults.
  if (asset?.anchors) {
    const a = asset.anchors.find((x) => x.id === OPTICAL_ANCHOR_ID);
    if (a) {
      return {
        offsetLocalMm: { x: a.positionMmBodyLocal.x, y: a.positionMmBodyLocal.y, z: a.positionMmBodyLocal.z },
        normalLocal: a.directionBodyLocal
          ? { x: a.directionBodyLocal.x, y: a.directionBodyLocal.y, z: a.directionBodyLocal.z }
          : null,
        source: "asset_anchor",
      };
    }
  }

  // 2. Mirror default — reflective face sits in front of body center along
  //    the mirror's surface normal. The mirror is symmetric about that
  //    axis, so face center = body center + n * thickness/2.
  //    V2 Phase 2 (alembic 0028): the normal now lives on the SceneObject's
  //    anchorBindings[opticalSurface].payload.normalBodyLocal — read it via
  //    the V2 helper so the asset_anchor branch above (case 1) still wins
  //    when explicit, and this branch only fires when the asset has no
  //    optical_anchor at all.
  if (el?.elementKind === "mirror") {
    const v2 = getMirrorNormalBodyLocal(obj ?? null);
    const nLocal: Vec3 = v2
      ? { x: v2[0], y: v2[1], z: v2[2] }
      : { x: 0, y: 0, z: 1 };
    const halfThickness = DEFAULT_MIRROR_THICKNESS_MM / 2;
    return {
      offsetLocalMm: { x: nLocal.x * halfThickness, y: nLocal.y * halfThickness, z: nLocal.z * halfThickness },
      normalLocal: nLocal,
      source: "kind_default_mirror",
    };
  }

  // 3. Default — body center, no offset, no normal.
  return {
    offsetLocalMm: { x: 0, y: 0, z: 0 },
    normalLocal: null,
    source: "kind_default_body",
  };
}

/** Given a target beam position and the anchor's local-frame offset, work
 *  back to where the object's xform origin (xMm/yMm/zMm) needs to be such
 *  that the anchor lands on the beam. The object's current rotation is
 *  used to transform the local offset into lab frame. */
export function objectPosForAnchorOnBeam(
  beamPos: Vec3,
  rxDeg: number,
  ryDeg: number,
  rzDeg: number,
  anchor: BeamAnchor,
): Vec3 {
  if (anchor.offsetLocalMm.x === 0 && anchor.offsetLocalMm.y === 0 && anchor.offsetLocalMm.z === 0) {
    return beamPos;
  }
  const labOffset = rotateLocalToLab(anchor.offsetLocalMm, rxDeg, ryDeg, rzDeg);
  return { x: beamPos.x - labOffset.x, y: beamPos.y - labOffset.y, z: beamPos.z - labOffset.z };
}

/** Inverse: given an object's current pose, return where its anchor lives
 *  in lab frame. Used by Re-snap to compute "current anchor position" for
 *  comparison purposes. */
export function anchorLabPos(
  objPosLab: Vec3,
  rxDeg: number,
  ryDeg: number,
  rzDeg: number,
  anchor: BeamAnchor,
): Vec3 {
  const labOffset = rotateLocalToLab(anchor.offsetLocalMm, rxDeg, ryDeg, rzDeg);
  return { x: objPosLab.x + labOffset.x, y: objPosLab.y + labOffset.y, z: objPosLab.z + labOffset.z };
}

/** Get the mirror's reflective face normal in lab frame, if applicable.
 *  Takes a SceneObject id (per-object optical chain). */
export function mirrorNormalLab(
  objectId: string,
  scene: { components: ComponentItem[]; assets: Asset3D[]; physicsElements: PhysicsElement[]; objects: SceneObjectLike[] },
): Vec3 | null {
  const anchor = getBeamAnchor(objectId, scene);
  if (!anchor.normalLocal) return null;
  const obj = scene.objects.find((o) => o.id === objectId);
  if (!obj) return null;
  return rotateLocalToLab(anchor.normalLocal, obj.rxDeg, obj.ryDeg, obj.rzDeg);
}
