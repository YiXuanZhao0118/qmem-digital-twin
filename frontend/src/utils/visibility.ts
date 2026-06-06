import type {
  AssemblyRelation,
  BeamSegment,
  Collection,
  SceneData,
  SceneObject,
} from "../types/digitalTwin";
import type {
  OverlayFlags,
  SessionVisibilityState,
} from "../types/visibility";

export type RenderableContext = {
  overlayFlags: OverlayFlags;
  session: SessionVisibilityState;
  scene: SceneData;
  // Memoized helpers — recomputed when inputs change.
  soloAllowed?: Set<string> | null;
  // Set of collection IDs whose own visibility AND every ancestor's visibility
  // resolve to true. Computed once per context. An object passes the collection
  // gate iff at least one of its memberships is in this set.
  visibleCollectionIds?: Set<string>;
  objectMemberships?: Map<string, string[]>;
};

export function computeVisibleCollectionIds(
  collections: Collection[],
  forceVisibleCollectionIds: Set<string> = new Set(),
): Set<string> {
  if (collections.length === 0) return new Set();
  const byId = new Map(collections.map((c) => [c.id, c]));
  const cache = new Map<string, boolean>();
  const visit = (id: string): boolean => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (!node) {
      cache.set(id, false);
      return false;
    }
    if (!node.visible) {
      cache.set(id, false);
      return false;
    }
    if (node.parentId === null || forceVisibleCollectionIds.has(id)) {
      cache.set(id, true);
      return true;
    }
    const ok = visit(node.parentId);
    cache.set(id, ok);
    return ok;
  };
  const out = new Set<string>();
  for (const collection of collections) {
    if (visit(collection.id)) out.add(collection.id);
  }
  return out;
}

function computeObjectMemberships(scene: SceneData): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const member of scene.collectionMembers ?? []) {
    const list = out.get(member.objectId);
    if (list) list.push(member.collectionId);
    else out.set(member.objectId, [member.collectionId]);
  }
  return out;
}

/** Resolve the solo set into the final allow-list of OBJECT ids.
 *
 *  - Empty solo → "no filter" → returns every scene object id (everyone allowed).
 *  - includeNeighbors=false → solo set itself.
 *  - includeNeighbors=true → solo set + 1 hop:
 *      * via opticalLinks (object-level): the connected SceneObject id.
 *      * via connections (still component-level in the data model): for each
 *        connection touching a soloed object's COMPONENT, expand to ALL
 *        SceneObjects of the OTHER endpoint's component. This is the only
 *        place a component→object fan-out is unavoidable, because the
 *        Connection table itself is keyed by component_id.
 */
export function resolveSolo(
  scene: SceneData,
  soloObjectIds: Set<string>,
  includeNeighbors: boolean,
): Set<string> {
  if (!soloObjectIds || soloObjectIds.size === 0) {
    return new Set(scene.objects.map((o) => o.id));
  }
  if (!includeNeighbors) return new Set(soloObjectIds);

  const expanded = new Set(soloObjectIds);
  for (const link of scene.opticalLinks ?? []) {
    if (soloObjectIds.has(link.fromObjectId)) expanded.add(link.toObjectId);
    if (soloObjectIds.has(link.toObjectId)) expanded.add(link.fromObjectId);
  }
  // Connections are per-OBJECT now (alembic 0015); expand directly.
  for (const conn of scene.connections ?? []) {
    if (soloObjectIds.has(conn.fromObjectId)) expanded.add(conn.toObjectId);
    if (soloObjectIds.has(conn.toObjectId)) expanded.add(conn.fromObjectId);
  }
  return expanded;
}

export function makeRenderableContext(
  overlayFlags: OverlayFlags,
  session: SessionVisibilityState,
  scene: SceneData,
): RenderableContext {
  const soloAllowed =
    session.soloObjectIds && session.soloObjectIds.size > 0
      ? resolveSolo(scene, session.soloObjectIds, session.soloIncludeNeighbors)
      : null;
  const visibleCollectionIds = computeVisibleCollectionIds(
    scene.collections ?? [],
    session.forceVisibleCollectionIds ?? new Set(),
  );
  const objectMemberships = computeObjectMemberships(scene);
  return {
    overlayFlags,
    session,
    scene,
    soloAllowed,
    visibleCollectionIds,
    objectMemberships,
  };
}

function objectPassesCollectionGate(objectId: string, ctx: RenderableContext): boolean {
  const visible = ctx.visibleCollectionIds;
  if (!visible) return true;
  const memberships = ctx.objectMemberships?.get(objectId);
  // No membership data yet (initial load) or membership not yet propagated:
  // permit the object so the renderer doesn't blink it out spuriously.
  if (!memberships || memberships.length === 0) return true;
  for (const collectionId of memberships) {
    if (visible.has(collectionId)) return true;
  }
  return false;
}

export function isCollectionVisible(collectionId: string, ctx: RenderableContext): boolean {
  const visible = ctx.visibleCollectionIds;
  if (!visible) return true;
  return visible.has(collectionId);
}

/** Authoritative instance-level visibility check.
 *
 *  All gates apply to the SceneObject (instance), not the Component template.
 *  The per-object gates (db visible, session hide, solo allow-list, collection
 *  ancestry) decide the final answer for each instance.
 */
export function isObjectVisible(object: SceneObject, ctx: RenderableContext): boolean {
  if (!ctx.overlayFlags.components) return false;
  if (!object.visible) return false;
  if (ctx.session.hiddenObjectIds.has(object.id)) return false;
  if (ctx.soloAllowed && !ctx.soloAllowed.has(object.id)) return false;
  // Force-visible override (request: collection viewBox=false but an
  // individual object toggled to true should still be visible). When the user explicitly toggles visibility ON for an
  // object inside an otherwise-hidden collection, the object id ends up
  // in session.forceVisibleObjectIds — bypass the collection gate so the
  // object resurfaces. We still respect overlayFlags / object.visible /
  // session hide / solo above; force-visible only beats the COLLECTION
  // cascade, not the user's other intentional hides.
  if (ctx.session.forceVisibleObjectIds?.has(object.id)) {
    // "Show object here" is an explicit per-object override — bypass the
    // collection cascade so the object always surfaces when the user has
    // explicitly requested it.
    return true;
  }
  if (!objectPassesCollectionGate(object.id, ctx)) return false;
  return true;
}

/** "Is at least one SceneObject of this component currently visible?"
 *
 *  Used only where the data model still references component templates
 *  (Connection) and we need a yes/no gate at that level.
 *  When the component has no instances, returns true so a brand-new
 *  catalog row never silently hides downstream cables.
 */
export function componentHasAnyVisibleObject(
  componentId: string,
  ctx: RenderableContext,
): boolean {
  const objs = ctx.scene.objects.filter((o) => o.componentId === componentId);
  if (objs.length === 0) return true;
  return objs.some((o) => isObjectVisible(o, ctx));
}

export function isBeamSegmentVisible(seg: BeamSegment, ctx: RenderableContext): boolean {
  if (!ctx.overlayFlags.beam_segments) return false;
  const link = ctx.scene.opticalLinks.find((l) => l.id === seg.opticalLinkId);
  if (!link) return false;
  if (ctx.session.hiddenLinkIds.has(link.id)) return false;
  // Per-object optical chain: link endpoints reference SceneObject ids, not
  // component ids. Resolve to the SceneObject and gate via isObjectVisible.
  const fromObj = ctx.scene.objects.find((o) => o.id === link.fromObjectId);
  const toObj = ctx.scene.objects.find((o) => o.id === link.toObjectId);
  if (!fromObj || !toObj) return false;
  return isObjectVisible(fromObj, ctx) && isObjectVisible(toObj, ctx);
}

export function isAssemblyRelationVisible(
  rel: AssemblyRelation,
  ctx: RenderableContext,
): boolean {
  if (!ctx.overlayFlags.assembly_relations) return false;
  if (ctx.session.hiddenRelationIds.has(rel.id)) return false;
  const a = ctx.scene.objects.find((o) => o.id === rel.objectAId);
  const b = ctx.scene.objects.find((o) => o.id === rel.objectBId);
  if (!a || !b) return false;
  return isObjectVisible(a, ctx) && isObjectVisible(b, ctx);
}
