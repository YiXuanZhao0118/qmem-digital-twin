/**
 * Rigid-group resolver — Collection.rigidTransform cascade.
 *
 * When a Collection has rigidTransform=true, every descendant SceneObject
 * (across the full sub-tree, recursively) is treated as one rigid body for
 * pose changes: a translate or rotate on any member must apply the same
 * rigid-body transform to all the other members. The flag cascades — a
 * collection inherits rigidTransform=true from any ancestor that has it,
 * so the effective group is rooted at the *highest* ancestor where the flag
 * is set.
 *
 * The resolver is read-only: it just answers "given this object, which
 * other SceneObject ids should move with it?". The store uses that set in
 * `updateSceneObject` to fan out a transform patch through the rigid
 * group; everywhere else (rendering, selection, deletion) ignores it.
 */

import * as THREE from "three";

import { labMmToThree, sceneObjectToQuaternion, threeToLabMm } from "../optical/frames";
import { capabilityProfile } from "../kinds/_capabilityProfile";
import type {
  Collection,
  CollectionMember,
  SceneData,
  SceneObject,
} from "../types/digitalTwin";

/** Pose patch shape — same fields the API accepts (subset of SceneObjectPatch). */
export type RigidPosePatch = {
  xMm?: number;
  yMm?: number;
  zMm?: number;
  rxDeg?: number;
  ryDeg?: number;
  rzDeg?: number;
};

const TRANSFORM_KEYS = ["xMm", "yMm", "zMm", "rxDeg", "ryDeg", "rzDeg"] as const;

/** True if the patch contains any pose fields (xMm/yMm/zMm/rxDeg/ryDeg/rzDeg). */
export function patchHasPoseChange(patch: RigidPosePatch): boolean {
  return TRANSFORM_KEYS.some((k) => patch[k] !== undefined);
}

/** Returns true if the collection itself OR any ancestor has rigidTransform=true.
 *  Walks parent_id chain; stops at NULL (Master Collection). Returns the id of
 *  the highest ancestor where the flag is on, or null if no group applies. */
function highestRigidAncestor(
  collectionId: string,
  byId: Map<string, Collection>,
): string | null {
  let cursor: string | null = collectionId;
  let highest: string | null = null;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) break; // defensive: malformed cycle
    visited.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    if (node.rigidTransform) highest = cursor;
    cursor = node.parentId;
  }
  return highest;
}

/** Pre-compute a child-by-parent index for cheap descendant traversal. */
function buildChildIndex(collections: Collection[]): Map<string | null, string[]> {
  const out = new Map<string | null, string[]>();
  for (const c of collections) {
    const list = out.get(c.parentId);
    if (list) list.push(c.id);
    else out.set(c.parentId, [c.id]);
  }
  return out;
}

/** Set of all collection ids in the sub-tree rooted at `rootId` (inclusive). */
function collectDescendantCollections(
  rootId: string,
  childIndex: Map<string | null, string[]>,
): Set<string> {
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const childId of childIndex.get(id) ?? []) {
      if (out.has(childId)) continue;
      out.add(childId);
      stack.push(childId);
    }
  }
  return out;
}

/** Resolve the rigid-group SceneObject ids that should move together with
 *  `objectId`. Always includes `objectId` itself. Returns a Set of size 1
 *  (just the input) when the object is not in any rigid group — that lets
 *  callers treat the result uniformly without a "no group" branch.
 *
 *  An object is in a rigid group iff its home collection (or any ancestor)
 *  has rigidTransform=true. The group is then every SceneObject that lives
 *  in the sub-tree rooted at the highest such ancestor (so toggling the
 *  flag near the root grows the group, toggling near a leaf shrinks it).
 */
export function resolveRigidGroup(
  scene: SceneData,
  objectId: string,
): Set<string> {
  const collections = scene.collections ?? [];
  const members = scene.collectionMembers ?? [];
  if (collections.length === 0) return new Set([objectId]);

  const byId = new Map(collections.map((c) => [c.id, c]));
  const homeByObject = new Map<string, string>();
  for (const m of members) homeByObject.set(m.objectId, m.collectionId);

  const startCollection = homeByObject.get(objectId);
  if (!startCollection) return new Set([objectId]);

  const groupRoot = highestRigidAncestor(startCollection, byId);
  if (!groupRoot) return new Set([objectId]);

  const childIndex = buildChildIndex(collections);
  const includedCollections = collectDescendantCollections(groupRoot, childIndex);

  const groupObjectIds = new Set<string>([objectId]);
  for (const m of members) {
    if (includedCollections.has(m.collectionId)) groupObjectIds.add(m.objectId);
  }
  return groupObjectIds;
}

/** Set of collection ids whose rigidTransform is *effectively* true — either
 *  the collection itself has the flag, or one of its ancestors does. Used by
 *  the outliner to render an inherited indicator on child rows. Computed in
 *  one pass over the tree (O(n)). */
export function computeRigidCollectionIds(collections: Collection[]): Set<string> {
  if (collections.length === 0) return new Set();
  const byId = new Map(collections.map((c) => [c.id, c]));
  const cache = new Map<string, boolean>();
  const isRigid = (id: string): boolean => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (!node) {
      cache.set(id, false);
      return false;
    }
    if (node.rigidTransform) {
      cache.set(id, true);
      return true;
    }
    if (node.parentId === null) {
      cache.set(id, false);
      return false;
    }
    const inherited = isRigid(node.parentId);
    cache.set(id, inherited);
    return inherited;
  };
  const out = new Set<string>();
  for (const c of collections) {
    if (isRigid(c.id)) out.add(c.id);
  }
  return out;
}

/** Helper used by both the rigid-group resolver and the outliner: collect every
 *  SceneObject id that lives in `collectionId` or any of its descendant
 *  collections (recursive). The outliner uses this for the bulk lock toggle
 *  ("flip all descendant objects' locked"). */
export function collectObjectIdsUnderCollection(
  collectionId: string,
  collections: Collection[],
  members: CollectionMember[],
): string[] {
  if (collections.length === 0) return [];
  const childIndex = buildChildIndex(collections);
  const included = collectDescendantCollections(collectionId, childIndex);
  const out: string[] = [];
  for (const m of members) {
    if (included.has(m.collectionId)) out.push(m.objectId);
  }
  return out;
}

export type RigidExpansionEntry = { id: string; patch: RigidPosePatch };

export type RigidExpansionResult =
  | { kind: "single"; entries: RigidExpansionEntry[] }
  | { kind: "group"; entries: RigidExpansionEntry[] }
  | { kind: "rejectedLockedMember"; lockedIds: string[] };

/** Expand a pose patch on the leading SceneObject into per-member patches that
 *  preserve the rigid group's relative pose.
 *
 *  Math:
 *    - leading old pose:  P_old = (pos_old, q_old)
 *    - leading new pose:  P_new = (pos_new, q_new)  [from patch ⊕ leading]
 *    - world-space rotation delta:  ΔR = q_new ⊗ q_old⁻¹
 *      (this rotates around the WORLD origin in three-space, but the math
 *       below pivots it around `pos_old` by subtracting first, rotating, then
 *       adding back — so it's effectively a pivot rotation around the leading)
 *    - world-space translation delta:  ΔT = pos_new − pos_old
 *
 *  For each non-leading member M:
 *    new_pos_M = pos_old + ΔR.apply(pos_M − pos_old) + ΔT
 *    new_q_M   = ΔR ⊗ q_M
 *
 *  All vector / quaternion math runs in three-frame (Y-up); positions cross
 *  the lab↔three boundary via labMmToThree / threeToLabMm. The returned
 *  patches are in lab/scene units (mm + degrees), ready for updateObjectApi.
 *
 *  Locked-member policy: if any non-leading member is locked, the rigid
 *  invariant cannot be maintained without violating that member's lock. The
 *  whole transform is rejected (`rejectedLockedMember`) and the caller does
 *  nothing — partial moves would silently break the "relative pose stays
 *  fixed" promise the user enables rigidTransform to get.
 *
 *  When the resolved group has size 1 (no rigid_transform applies), the
 *  result has kind="single" and the leading patch is the only entry —
 *  callers can treat single/group uniformly.
 */
export function expandPoseToRigidGroup(
  scene: SceneData,
  leading: SceneObject,
  patch: RigidPosePatch,
): RigidExpansionResult {
  const leadEntry: RigidExpansionEntry = { id: leading.id, patch };

  const groupIds = resolveRigidGroup(scene, leading.id);
  if (groupIds.size <= 1) {
    return { kind: "single", entries: [leadEntry] };
  }

  const objsById = new Map(scene.objects.map((o) => [o.id, o]));
  // Capability-profile filter — kinds with `rigidGroupParticipant: false`
  // (rf_cable / PPG today, future hidden fiber body) are skipped because
  // their lab pose is fully derived at draw time from their anchor /
  // mating peers; any patch we'd hand them here is overwritten on the
  // next render. Dragging a rigid group should move the peers and let
  // these derived-pose kinds auto-track.
  const skipObjectIds = new Set(
    scene.physicsElements
      .filter((pe) => !capabilityProfile(pe.elementKind).rigidGroupParticipant)
      .map((pe) => pe.objectId),
  );
  const otherIds = Array.from(groupIds).filter(
    (id) => id !== leading.id && !skipObjectIds.has(id),
  );

  const lockedIds = otherIds.filter((id) => objsById.get(id)?.locked === true);
  if (lockedIds.length > 0) {
    return { kind: "rejectedLockedMember", lockedIds };
  }

  // Merge patch with leading's current pose to get the full target pose.
  const oldPose = {
    xMm: leading.xMm,
    yMm: leading.yMm,
    zMm: leading.zMm,
    rxDeg: leading.rxDeg,
    ryDeg: leading.ryDeg,
    rzDeg: leading.rzDeg,
  };
  const newPose = {
    xMm: patch.xMm ?? oldPose.xMm,
    yMm: patch.yMm ?? oldPose.yMm,
    zMm: patch.zMm ?? oldPose.zMm,
    rxDeg: patch.rxDeg ?? oldPose.rxDeg,
    ryDeg: patch.ryDeg ?? oldPose.ryDeg,
    rzDeg: patch.rzDeg ?? oldPose.rzDeg,
  };
  const oldLeading = { ...leading, ...oldPose };
  const newLeading = { ...leading, ...newPose };

  const oldQ = sceneObjectToQuaternion(oldLeading);
  const newQ = sceneObjectToQuaternion(newLeading);
  const deltaQ = newQ.clone().multiply(oldQ.clone().invert());

  const leadOldThree = labMmToThree(oldPose);
  const leadNewThree = labMmToThree(newPose);
  const deltaTThree = leadNewThree.clone().sub(leadOldThree);

  const entries: RigidExpansionEntry[] = [leadEntry];

  for (const id of otherIds) {
    const member = objsById.get(id);
    if (!member) continue;
    const memberThree = labMmToThree({ xMm: member.xMm, yMm: member.yMm, zMm: member.zMm });
    const rel = memberThree.clone().sub(leadOldThree).applyQuaternion(deltaQ);
    const newMemberThree = leadOldThree.clone().add(rel).add(deltaTThree);
    const newMemberLab = threeToLabMm(newMemberThree);

    const memberQ = sceneObjectToQuaternion(member);
    const newMemberQ = deltaQ.clone().multiply(memberQ);
    // Inverse of sceneObjectToQuaternion's YXZ Euler(rxRad, rzRad, -ryRad):
    const e = new THREE.Euler().setFromQuaternion(newMemberQ, "YXZ");
    const newRxDeg = THREE.MathUtils.radToDeg(e.x);
    const newRzDeg = THREE.MathUtils.radToDeg(e.y);
    const newRyDeg = -THREE.MathUtils.radToDeg(e.z);

    entries.push({
      id: member.id,
      patch: {
        xMm: newMemberLab.xMm,
        yMm: newMemberLab.yMm,
        zMm: newMemberLab.zMm,
        rxDeg: newRxDeg,
        ryDeg: newRyDeg,
        rzDeg: newRzDeg,
      },
    });
  }
  return { kind: "group", entries };
}
