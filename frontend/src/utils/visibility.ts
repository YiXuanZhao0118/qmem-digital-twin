import type {
  AssemblyRelation,
  BeamPath,
  BeamSegment,
  Collection,
  ConnectionItem,
  OpticalLink,
  PhysicsCapability,
  SceneData,
  SceneObject,
} from "../types/digitalTwin";
import type {
  OverlayFlags,
  SceneView,
  SessionVisibilityState,
  ViewFilterExpr,
} from "../types/visibility";

export type RenderableContext = {
  overlayFlags: OverlayFlags;
  session: SessionVisibilityState;
  activeView: SceneView | null;
  scene: SceneData;
  // Memoized helpers — recomputed when inputs change.
  soloAllowed?: Set<string> | null;
  reachableCache?: Map<string, Set<string>>;
  viewMatchCache?: Map<string, boolean>;
  // Set of collection IDs whose own visibility AND every ancestor's visibility
  // resolve to true (and no ancestor has exclude=true). Computed once per
  // context. An object passes the collection gate iff at least one of its
  // memberships is in this set.
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
    if (!node.visible || node.exclude) {
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
  activeView: SceneView | null,
  scene: SceneData,
): RenderableContext {
  const soloAllowed =
    session.soloObjectIds && session.soloObjectIds.size > 0
      ? resolveSolo(scene, session.soloObjectIds, session.soloIncludeNeighbors)
      : null;
  const effectiveOverlays: OverlayFlags = activeView?.overlayOverrides
    ? { ...overlayFlags, ...activeView.overlayOverrides }
    : overlayFlags;
  const visibleCollectionIds = computeVisibleCollectionIds(
    scene.collections ?? [],
    session.forceVisibleCollectionIds ?? new Set(),
  );
  const objectMemberships = computeObjectMemberships(scene);
  return {
    overlayFlags: effectiveOverlays,
    session,
    activeView,
    scene,
    soloAllowed,
    reachableCache: new Map(),
    viewMatchCache: new Map(),
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

function reachableSet(
  scene: SceneData,
  sourceComponentId: string,
  via: ("optical" | "connection" | "rf")[],
  maxHops: number,
  cache?: Map<string, Set<string>>,
): Set<string> {
  const cacheKey = `${sourceComponentId}|${[...via].sort().join(",")}|${maxHops}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey)!;

  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };
  // Project per-object edges (opticalLinks + connections post-0015) onto
  // component-space so the view filter's "reachable_from" can keep
  // operating on component templates.
  const compOf = new Map(scene.objects.map((o) => [o.id, o.componentId]));
  if (via.includes("optical")) {
    for (const link of scene.opticalLinks ?? []) {
      const f = compOf.get(link.fromObjectId);
      const t = compOf.get(link.toObjectId);
      if (f && t) addEdge(f, t);
    }
  }
  if (via.includes("connection") || via.includes("rf")) {
    for (const conn of scene.connections ?? []) {
      if (via.includes("rf") && !via.includes("connection")) {
        const t = (conn.connectionType ?? "").toLowerCase();
        if (!t.includes("rf") && !t.includes("coax")) continue;
      }
      const f = compOf.get(conn.fromObjectId);
      const t = compOf.get(conn.toObjectId);
      if (f && t) addEdge(f, t);
    }
  }
  const visited = new Set<string>([sourceComponentId]);
  let frontier = new Set<string>([sourceComponentId]);
  for (let hop = 0; hop < Math.max(0, maxHops); hop += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const nbr of adjacency.get(id) ?? []) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          next.add(nbr);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  cache?.set(cacheKey, visited);
  return visited;
}

function evalFilter(
  componentId: string,
  expr: ViewFilterExpr,
  scene: SceneData,
  cache?: Map<string, Set<string>>,
): boolean {
  switch (expr.type) {
    case "all":
      return true;
    case "and":
      return expr.clauses.every((c) => evalFilter(componentId, c, scene, cache));
    case "or":
      return expr.clauses.some((c) => evalFilter(componentId, c, scene, cache));
    case "not":
      return !evalFilter(componentId, expr.clause, scene, cache);
    case "component_type": {
      const c = scene.components.find((x) => x.id === componentId);
      return c ? expr.values.includes(c.componentType) : false;
    }
    case "physics_capability": {
      const c = scene.components.find((x) => x.id === componentId);
      if (!c) return false;
      return expr.values.some((v: PhysicsCapability) => c.physicsCapabilities.includes(v));
    }
    case "wavelength_range": {
      // Per-object optical chain — find any OE whose object belongs to this component.
      const objIds = new Set(scene.objects.filter((o) => o.componentId === componentId).map((o) => o.id));
      const oe = scene.opticalElements.find((x) => objIds.has(x.objectId));
      if (!oe) return false;
      const [lo, hi] = oe.wavelengthRangeNm;
      return !(hi < expr.lowNm || lo > expr.highNm);
    }
    case "tag": {
      const c = scene.components.find((x) => x.id === componentId);
      if (!c) return false;
      const tags = (c.properties?.tags as string[] | undefined) ?? [];
      return expr.values.some((v) => tags.includes(v));
    }
    case "reachable_from": {
      const set = reachableSet(scene, expr.sourceComponentId, expr.via, expr.maxHops, cache);
      return set.has(componentId);
    }
    case "component_ids":
      return expr.values.includes(componentId);
    case "in_region":
    case "in_stage":
      // Phase 2/3 placeholders — no-op (return false), do not throw.
      // eslint-disable-next-line no-console
      console.warn(`[visibility] view filter type '${expr.type}' not yet implemented`);
      return false;
    default: {
      // eslint-disable-next-line no-console
      console.warn(`[visibility] unknown view filter type`, expr);
      return false;
    }
  }
}

export function matchesView(
  componentId: string,
  view: SceneView,
  scene: SceneData,
  cache?: Map<string, Set<string>>,
  matchCache?: Map<string, boolean>,
): boolean {
  if (matchCache?.has(componentId)) return matchCache.get(componentId)!;
  const result = evalFilter(componentId, view.filterExpr, scene, cache);
  matchCache?.set(componentId, result);
  return result;
}

/** Authoritative instance-level visibility check.
 *
 *  All gates apply to the SceneObject (instance), not the Component template:
 *  the only piece that's still per-component is the saved-view filter, which
 *  intentionally targets component templates (e.g. "show all mirrors").
 *  Objects of a matching component are then admitted; the per-object gates
 *  (db visible, session hide, solo allow-list, collection ancestry) decide
 *  the final answer for each instance.
 */
export function isObjectVisible(object: SceneObject, ctx: RenderableContext): boolean {
  if (!ctx.overlayFlags.components) return false;
  if (!object.visible) return false;
  if (ctx.session.hiddenObjectIds.has(object.id)) return false;
  if (ctx.soloAllowed && !ctx.soloAllowed.has(object.id)) return false;
  // Force-visible override (request: collection viewBox=false 但個別 object
  // 改 true 仍可見). When the user explicitly toggles visibility ON for an
  // object inside an otherwise-hidden collection, the object id ends up
  // in session.forceVisibleObjectIds — bypass the collection gate so the
  // object resurfaces. We still respect overlayFlags / object.visible /
  // session hide / solo above; force-visible only beats the COLLECTION
  // cascade, not the user's other intentional hides.
  if (ctx.session.forceVisibleObjectIds?.has(object.id)) {
    // "Show object here" is an explicit per-object override — bypass the
    // collection cascade AND the active-view filter so the object always
    // surfaces when the user has explicitly requested it.
    return true;
  }
  if (!objectPassesCollectionGate(object.id, ctx)) return false;
  if (ctx.activeView) {
    const ok = matchesView(
      object.componentId,
      ctx.activeView,
      ctx.scene,
      ctx.reachableCache,
      ctx.viewMatchCache,
    );
    if (!ok) return false;
  }
  return true;
}

/** "Is at least one SceneObject of this component currently visible?"
 *
 *  Used only where the data model still references component templates
 *  (BeamPath, Connection) and we need a yes/no gate at that level.
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

export function isBeamPathVisible(beam: BeamPath, ctx: RenderableContext): boolean {
  if (!ctx.overlayFlags.beam_paths) return false;
  if (!beam.visible) return false;
  if (ctx.session.hiddenBeamPathIds.has(beam.id)) return false;
  // BeamPath endpoints are per-OBJECT now (alembic 0015).
  if (beam.sourceObjectId) {
    const src = ctx.scene.objects.find((o) => o.id === beam.sourceObjectId);
    if (!src || !isObjectVisible(src, ctx)) return false;
  }
  if (beam.targetObjectId) {
    const tgt = ctx.scene.objects.find((o) => o.id === beam.targetObjectId);
    if (!tgt || !isObjectVisible(tgt, ctx)) return false;
  }
  return true;
}

export function isOpticalLinkVisible(link: OpticalLink, ctx: RenderableContext): boolean {
  if (!ctx.overlayFlags.optical_links) return false;
  if (ctx.session.hiddenLinkIds.has(link.id)) return false;
  // Same per-object lookup as isBeamSegmentVisible — endpoints are SceneObject ids.
  const fromObj = ctx.scene.objects.find((o) => o.id === link.fromObjectId);
  const toObj = ctx.scene.objects.find((o) => o.id === link.toObjectId);
  if (!fromObj || !toObj) return false;
  return isObjectVisible(fromObj, ctx) && isObjectVisible(toObj, ctx);
}

export function isConnectionVisible(conn: ConnectionItem, ctx: RenderableContext): boolean {
  if (!ctx.overlayFlags.connections) return false;
  if (ctx.session.hiddenLinkIds.has(conn.id)) return false;
  // Connections are per-OBJECT now (alembic 0015).
  const fromObj = ctx.scene.objects.find((o) => o.id === conn.fromObjectId);
  const toObj = ctx.scene.objects.find((o) => o.id === conn.toObjectId);
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
