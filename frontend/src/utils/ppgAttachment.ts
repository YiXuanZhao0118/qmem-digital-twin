/**
 * PPG ↔ instrument port attachment.
 *
 * A Programmable Pulse Generator plugs DIRECTLY into a peer instrument's
 * coax port (switch `ttl_in`, AOM `trigger_in`, …) — there is no cable
 * between them, and physically there could not be: the PPG's `rf_out` is a
 * male connector and every cable in the catalog is male on both ends.
 *
 * The attachment therefore lives as a record on the PPG's own SceneObject:
 *
 *     SceneObject.properties.ppgAttachment = {
 *       targetObjectId, targetAnchorId, targetAnchorName
 *     }
 *
 * It plays two roles:
 *   1. **Pose** — `ppgMounting.computePpgMountedThreePose` mates the PPG's
 *      `rf_out` onto the named target anchor.
 *   2. **Graph edge** — the RF BFS, the RF Link panel and the backend
 *      resolver all treat it as a zero-length edge between
 *      `PPG.rf_out` and the target port, exactly where an rf_cable edge
 *      would otherwise sit.
 *
 * ### Why this replaced a real rf_cable (2026-08-14)
 *
 * `createPpgAtPort` used to create an actual rf_cable SceneObject to record
 * the relationship, which the viewer then force-hid because a zero-length
 * spline degenerates to a point. That made it an invisible first-class
 * object which was still selectable, deletable, and hideable — and every one
 * of those turned into a bug: clicking the invisible cable ran the Object
 * panel's dangling-link cleanup and deleted it (taking the PPG with it via
 * the orphan cascade), and permanently hiding it stranded a row no UI could
 * reach. An attachment record has no SceneObject of its own, so none of
 * those failure modes exist.
 *
 * Legacy scenes whose PPG is still wired through an rf_cable keep working —
 * every reader falls back to the cable edge (see `ppgAttachmentOf`'s callers).
 */
import type { PhysicsElement, SceneObject } from "../types/digitalTwin";

export const PPG_ELEMENT_KIND = "programmable_pulse_generator";

export type PpgAttachment = {
  targetObjectId: string;
  targetAnchorId: string;
  targetAnchorName: string;
};

/** The attachment record on a PPG SceneObject, or null when absent /
 *  malformed. Does NOT check that the object is actually a PPG — callers
 *  that care filter by `elementKind` first (cheaper than threading the
 *  PhysicsElement list through every call site). */
export function ppgAttachmentOf(object: SceneObject | null | undefined): PpgAttachment | null {
  const raw = (object?.properties as { ppgAttachment?: unknown } | null | undefined)?.ppgAttachment;
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<PpgAttachment>;
  if (
    typeof a.targetObjectId !== "string" || !a.targetObjectId
    || typeof a.targetAnchorId !== "string" || !a.targetAnchorId
    || typeof a.targetAnchorName !== "string" || !a.targetAnchorName
  ) {
    return null;
  }
  return {
    targetObjectId: a.targetObjectId,
    targetAnchorId: a.targetAnchorId,
    targetAnchorName: a.targetAnchorName,
  };
}

/** Every `(ppgObjectId, attachment)` pair in the scene. */
export function ppgAttachments(
  objects: readonly SceneObject[],
  physicsElements: readonly PhysicsElement[],
): { ppgObjectId: string; attachment: PpgAttachment }[] {
  const isPpg = new Set(
    physicsElements.filter((pe) => pe.elementKind === PPG_ELEMENT_KIND).map((pe) => pe.objectId),
  );
  const out: { ppgObjectId: string; attachment: PpgAttachment }[] = [];
  for (const obj of objects) {
    if (!isPpg.has(obj.id)) continue;
    const attachment = ppgAttachmentOf(obj);
    if (attachment) out.push({ ppgObjectId: obj.id, attachment });
  }
  return out;
}

/** SceneObject ids of every PPG attached to any of `targetObjectIds`.
 *  Drives the delete cascade: removing an instrument removes the PPGs
 *  plugged into it, the same way it removes cables that pointed at it. */
export function ppgsAttachedTo(
  objects: readonly SceneObject[],
  physicsElements: readonly PhysicsElement[],
  targetObjectIds: ReadonlySet<string>,
): string[] {
  return ppgAttachments(objects, physicsElements)
    .filter((p) => targetObjectIds.has(p.attachment.targetObjectId))
    .map((p) => p.ppgObjectId);
}
