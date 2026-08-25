/**
 * Anchor -> lab pose, resolved through the Component binding tree.
 *
 * The frontend had no single place to answer "where, in lab mm, is this
 * object's `intercept_face`, and which way does it point?".
 * `anchorsInBindingTree` (componentBindings.ts) returns anchors in their
 * owning ASSET's body frame — correct for identity questions, wrong for
 * geometry, because a binding's local transform still sits between the asset
 * and the Component CAD frame. Call sites that needed the pose each
 * re-implemented part of the walk (`collectRoleCentres` for role centres,
 * `AlignToBeamControls` for its single-asset fallback), and neither composed
 * nested bindings.
 *
 * The composition here mirrors the two authorities exactly:
 *   asset body -> Component CAD : `bindingTreeObject.applyBindingLocalTransform`
 *                                 (raw THREE XYZ Euler, no lab/three swap)
 *   Component CAD -> lab        : `optical/frames.rotateLabDir` + the object
 *                                 origin (the SceneObject's own YXZ-remapped
 *                                 rotation convention)
 *
 * Invariant: the lab pose returned here must equal the backend's
 * (`db_scene_loader._binding_tree_transform` composed with
 * `pose.pose_to_transform`), or anything that solves a pose from these
 * numbers lands where the ray tracer disagrees. Pinned end-to-end in
 * `utils/__tests__/mirrorCoupling.test.ts` against a traced hit point.
 */
import * as THREE from "three";

import type { Anchor, Asset3D, ComponentItem, SceneData, SceneObject } from "../types/digitalTwin";
import { rotateLabDir } from "../optical/frames";
import type { Vec3 } from "./anchorAccess";
import { anchorObjectLocalPos, anchorObjectLocalPrimaryDir } from "./anchorAccess";
import { resolveBindingTree, type ResolvedBindingNode } from "./componentBindings";

export type AnchorPoseLab = {
  anchorId: string;
  /** `anchor.name ?? anchor.id` — the port identity used for dedupe. */
  anchorName: string;
  asset: Asset3D;
  anchor: Anchor;
  /** Anchor origin in the Component CAD frame (mm). Feed this to
   *  `computePointDirAlignPose` / `computeTranslateOnlyPose`. */
  posCad: Vec3;
  /** Primary direction (axisX, else legacy directionBodyLocal) in the
   *  Component CAD frame, unit. null when the anchor declares none. */
  axisXCad: Vec3 | null;
  /** Anchor origin in lab mm. */
  posLab: Vec3;
  /** Primary direction in lab, unit. null when the anchor declares none. */
  axisXLab: Vec3 | null;
  /** Clear-aperture RADIUS in mm — the backend's `aperture_mm` semantics
   *  (`r > aperture_mm` misses). null when the anchor declares none. */
  apertureMm: number | null;
};

type SceneSlice = Pick<
  SceneData,
  "componentBindings" | "objectBindings" | "assets" | "components"
>;

type Collected = { asset: Asset3D; anchor: Anchor; posCad: Vec3; axisXCad: Vec3 | null };

function unit(v: Vec3): Vec3 | null {
  const m = Math.hypot(v.x, v.y, v.z);
  return m < 1e-9 ? null : { x: v.x / m, y: v.y / m, z: v.z / m };
}

/** Component CAD-frame point -> lab mm under a SceneObject pose. The same
 *  path `isolatorAlign.cadToLab` takes; kept local so this module does not
 *  depend on the align family (which already imports binding types from the
 *  other direction). */
function cadPointToLab(cad: Vec3, sceneObject: SceneObject): Vec3 {
  const r = rotateLabDir(cad, sceneObject);
  return { x: sceneObject.xMm + r.x, y: sceneObject.yMm + r.y, z: sceneObject.zMm + r.z };
}

function walk(
  nodes: readonly ResolvedBindingNode[],
  parentPos: THREE.Vector3,
  parentQuat: THREE.Quaternion,
  seen: Set<string>,
  out: Collected[],
): void {
  for (const node of nodes) {
    const t = node.localTransform;
    // RAW XYZ Euler in the parent CAD frame — matches
    // bindingTreeObject.applyBindingLocalTransform and
    // ComponentsEditor.poseFromBinding. NOT the SceneObject's YXZ remap.
    const localQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(t.rxDeg),
        THREE.MathUtils.degToRad(t.ryDeg),
        THREE.MathUtils.degToRad(t.rzDeg),
        "XYZ",
      ),
    );
    const worldPos = new THREE.Vector3(t.xMm, t.yMm, t.zMm)
      .applyQuaternion(parentQuat)
      .add(parentPos);
    const worldQuat = parentQuat.clone().multiply(localQuat);

    if (node.target.kind === "asset") {
      const asset = node.target.asset;
      for (const anchor of asset.anchors ?? []) {
        const key = `${anchor.id}|${anchor.name ?? anchor.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const p = anchorObjectLocalPos(anchor, asset);
        const posCad = new THREE.Vector3(p.x, p.y, p.z)
          .applyQuaternion(worldQuat)
          .add(worldPos);
        const dirLocal = anchorObjectLocalPrimaryDir(anchor, asset);
        let axisXCad: Vec3 | null = null;
        if (dirLocal) {
          const d = new THREE.Vector3(dirLocal.x, dirLocal.y, dirLocal.z)
            .applyQuaternion(worldQuat);
          axisXCad = unit({ x: d.x, y: d.y, z: d.z });
        }
        out.push({
          asset,
          anchor,
          posCad: { x: posCad.x, y: posCad.y, z: posCad.z },
          axisXCad,
        });
      }
    }
    if (node.children.length > 0) {
      walk(node.children, worldPos, worldQuat, seen, out);
    }
  }
}

/** Every anchor in `component`'s binding tree, posed in the Component CAD
 *  frame AND in lab mm under `sceneObject`. Deduped by `id|name` (the port
 *  identity), first occurrence winning — the same rule
 *  `anchorsInBindingTree` uses, so the two agree on which anchor a
 *  duplicated id refers to.
 *
 *  Falls back to the legacy pre-binding shape (the asset hanging straight
 *  off `component.asset3dId`) when the tree yields nothing. */
export function resolveAnchorPosesLab(
  component: ComponentItem,
  sceneObject: SceneObject,
  scene: SceneSlice,
): AnchorPoseLab[] {
  const collected: Collected[] = [];
  walk(
    resolveBindingTree(component, sceneObject, scene),
    new THREE.Vector3(),
    new THREE.Quaternion(),
    new Set<string>(),
    collected,
  );

  if (collected.length === 0 && component.asset3dId) {
    const asset = (scene.assets ?? []).find((a) => a.id === component.asset3dId);
    if (asset) {
      for (const anchor of asset.anchors ?? []) {
        const dir = anchorObjectLocalPrimaryDir(anchor, asset);
        collected.push({
          asset,
          anchor,
          posCad: anchorObjectLocalPos(anchor, asset),
          axisXCad: dir ? unit(dir) : null,
        });
      }
    }
  }

  return collected.map(({ asset, anchor, posCad, axisXCad }) => ({
    anchorId: anchor.id,
    anchorName: anchor.name ?? anchor.id,
    asset,
    anchor,
    posCad,
    axisXCad,
    posLab: cadPointToLab(posCad, sceneObject),
    axisXLab: axisXCad ? unit(rotateLabDir(axisXCad, sceneObject)) : null,
    apertureMm:
      typeof anchor.apertureMm === "number" && anchor.apertureMm > 0
        ? anchor.apertureMm
        : null,
  }));
}

/** One anchor by id, or null. Convenience over `resolveAnchorPosesLab`. */
export function resolveAnchorPoseLab(
  component: ComponentItem,
  sceneObject: SceneObject,
  scene: SceneSlice,
  anchorId: string,
): AnchorPoseLab | null {
  return (
    resolveAnchorPosesLab(component, sceneObject, scene).find((a) => a.anchorId === anchorId)
    ?? null
  );
}

/** Same, keyed off the SceneObject — looks the Component up for you.
 *  Returns [] when the object's Component row is not in the scene. */
export function resolveObjectAnchorPosesLab(
  sceneObject: SceneObject,
  scene: SceneSlice,
): AnchorPoseLab[] {
  const component = (scene.components ?? []).find((c) => c.id === sceneObject.componentId);
  if (!component) return [];
  return resolveAnchorPosesLab(component, sceneObject, scene);
}
