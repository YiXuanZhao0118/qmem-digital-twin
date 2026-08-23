/**
 * ComponentBinding tree helpers (alembic 0062).
 *
 * The catalog-side composition tree (ComponentBinding rows) lets a
 * Component fan out into multiple Asset3Ds and/or nested sub-Components
 * arranged by local transform. This module is the read-side glue
 * between that data and the renderer / utility layers:
 *
 *   bindingsFor()       — flat scene bindings → per-Component list
 *   rootBindingsOf()    — top-level bindings of a Component (parent === null)
 *   childrenOf()        — children of a binding within its Component
 *   primaryAsset()      — single-root-asset fast path for legacy callers
 *
 * Legacy callers that previously did
 *
 *     const asset = scene.assets.find(a => a.id === comp.asset3dId);
 *
 * can drop in
 *
 *     const asset = primaryAsset(comp, scene);
 *
 * and stay binary-equivalent for every component whose binding tree is
 * one root pointing at an asset (i.e. the 518 backfilled rows). Once a
 * Component grows composite (isolator, mirror_mount, …) primaryAsset
 * still returns the root-asset for the "what's the main geometry" call
 * sites, and full-tree consumers should switch to rootBindingsOf().
 */
import type {
  Anchor,
  Asset3D,
  ComponentBinding,
  ComponentItem,
  ObjectBinding,
  SceneData,
  SceneObject,
} from "../types/digitalTwin";
import type { BindingPose } from "./portConnectorPlacement";
import { findCableRootAnchor, findMatingFaceAnchor } from "./connectorAnchors";


/** Group a flat binding list by componentId. Returns a Map for O(1)
 *  lookup; useful when a caller will iterate multiple components. */
export function bindingsByComponent(
  bindings: ComponentBinding[] | undefined,
): Map<string, ComponentBinding[]> {
  const out = new Map<string, ComponentBinding[]>();
  if (!bindings) return out;
  for (const b of bindings) {
    const list = out.get(b.componentId);
    if (list) list.push(b);
    else out.set(b.componentId, [b]);
  }
  return out;
}


/** All bindings owned by ``componentId`` in scene order (sortOrder
 *  asc, ties broken by createdAt — the backend already sorts so we
 *  trust the incoming order). */
export function bindingsFor(
  componentId: string,
  scene: { componentBindings?: readonly ComponentBinding[] },
): ComponentBinding[] {
  const all = scene.componentBindings ?? [];
  return all.filter((b) => b.componentId === componentId);
}


/** Top-level bindings of a Component (parentBindingId === null). A
 *  Component usually has one root, but multi-root is legal (no single
 *  anchoring body). */
export function rootBindingsOf(
  componentId: string,
  scene: { componentBindings?: readonly ComponentBinding[] },
): ComponentBinding[] {
  return bindingsFor(componentId, scene).filter(
    (b) => b.parentBindingId === null,
  );
}


/** Direct children of ``binding`` within the same Component. Caller
 *  recurses on the result for full-tree traversal. */
export function childrenOf(
  binding: ComponentBinding,
  scene: Pick<SceneData, "componentBindings">,
): ComponentBinding[] {
  return bindingsFor(binding.componentId, scene).filter(
    (b) => b.parentBindingId === binding.id,
  );
}


/** Resolve the "main geometry" Asset3D for a Component.
 *
 *  Priority:
 *    1. Single root binding with targetKind="asset" → that asset (the
 *       backfilled common case).
 *    2. Legacy ``component.asset3dId`` fallback (pre-binding scenes,
 *       or rows that somehow never got a binding row).
 *
 *  Returns null when neither applies — typically a composite Component
 *  with multiple roots or a subcomponent-rooted tree, where the caller
 *  should walk the binding tree explicitly instead of asking for "the"
 *  asset.
 */
export function primaryAsset(
  component: ComponentItem,
  scene: {
    componentBindings?: readonly ComponentBinding[];
    assets: readonly Asset3D[];
  },
): Asset3D | null {
  const roots = rootBindingsOf(component.id, scene);
  if (roots.length === 1 && roots[0].targetKind === "asset" && roots[0].asset3dId) {
    const id = roots[0].asset3dId;
    return scene.assets.find((a) => a.id === id) ?? null;
  }
  if (component.asset3dId) {
    return scene.assets.find((a) => a.id === component.asset3dId) ?? null;
  }
  return null;
}


/** Resolved local transform for a binding after per-instance overrides
 *  have been applied. All six axes are non-optional so renderers can
 *  consume the same shape without per-axis presence checks. */
export type ResolvedLocalTransform = {
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
};


/** One node of a Component's binding tree, resolved to concrete data
 *  (target object + effective transform). The tree shape mirrors the
 *  binding tree exactly — ``children`` is the recursive resolution of
 *  bindings whose parent is this one.
 *
 *  ``target`` is a discriminated union so a renderer can switch on
 *  ``target.kind`` without re-walking the scene to figure out which
 *  side of the polymorphic FK fired. ``"missing"`` covers the rare
 *  case where the binding points at an asset / subcomponent the
 *  scene doesn't include — most consumers should treat it the same
 *  as a no-op (skip the subtree, log if surprising). */
export type ResolvedBindingTarget =
  | { kind: "asset"; asset: Asset3D }
  | { kind: "subcomponent"; component: ComponentItem }
  | { kind: "empty" }
  | { kind: "missing"; reason: "asset" | "subcomponent" };


export type ResolvedBindingNode = {
  binding: ComponentBinding;
  target: ResolvedBindingTarget;
  /** Effective local transform = binding's declared local* fields
   *  PLUS any per-instance ``SceneObject.properties.bindingOverrides``
   *  delta for this binding. Override values are added per axis; the
   *  binding row stays the catalog-shared calibrated baseline. */
  localTransform: ResolvedLocalTransform;
  children: ResolvedBindingNode[];
};


function _effectiveTransform(
  binding: ComponentBinding,
  objectBinding: ObjectBinding | null | undefined,
): ResolvedLocalTransform {
  // ADDITIVE semantics: ObjectBinding.local_*_delta values are added on
  // top of the ComponentBinding's declared baseline. ``null`` on a
  // delta means "no override for that axis" → contributes zero. Keeps
  // the catalog-shared baseline as the source of truth and lets
  // per-instance overrides stack tunable adjustments without
  // overwriting it.
  //
  // Deltas are interpreted in the frame declared by
  // binding.tunableAxes — the renderer applies the frame mapping after
  // this function returns since frame semantics depend on the
  // surrounding tree state.
  const num = (v: number | null | undefined): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    xMm: binding.localXMm + num(objectBinding?.localXMmDelta),
    yMm: binding.localYMm + num(objectBinding?.localYMmDelta),
    zMm: binding.localZMm + num(objectBinding?.localZMmDelta),
    rxDeg: binding.localRxDeg + num(objectBinding?.localRxDegDelta),
    ryDeg: binding.localRyDeg + num(objectBinding?.localRyDegDelta),
    rzDeg: binding.localRzDeg + num(objectBinding?.localRzDegDelta),
  };
}


function _resolveTarget(
  binding: ComponentBinding,
  scene: Pick<SceneData, "assets" | "components">,
): ResolvedBindingTarget {
  if (binding.targetKind === "asset") {
    if (!binding.asset3dId) return { kind: "missing", reason: "asset" };
    const asset = scene.assets.find((a) => a.id === binding.asset3dId);
    return asset
      ? { kind: "asset", asset }
      : { kind: "missing", reason: "asset" };
  }
  if (binding.targetKind === "empty") {
    return { kind: "empty" };
  }
  if (!binding.subComponentId) return { kind: "missing", reason: "subcomponent" };
  const component = scene.components.find((c) => c.id === binding.subComponentId);
  return component
    ? { kind: "subcomponent", component }
    : { kind: "missing", reason: "subcomponent" };
}


/** Resolve every root binding of ``component`` into a fully-populated
 *  tree. Walk is purely synchronous + pure-data — the caller does
 *  whatever it needs (build THREE.Group, compute bounding box, render
 *  HTML preview, etc.) on the returned structure.
 *
 *  ``sceneObject`` carries the per-instance ``bindingOverrides`` map.
 *  Pass ``null`` for catalog-time previews where no instance exists
 *  yet — the resolver falls through to declared defaults for every
 *  axis.
 *
 *  Sub-component bindings recurse into the sub-Component's OWN root
 *  bindings, NOT into a per-instance override (sub-component
 *  instances don't exist in this scope — the binding tree is purely
 *  catalog-side). If a sub-Component has its own composite tree, the
 *  walker descends through it; the result is a flattened renderer
 *  payload that captures the full assembly geometry.
 */
export function resolveBindingTree(
  component: ComponentItem,
  sceneObject: SceneObject | null,
  scene: Pick<SceneData, "componentBindings" | "objectBindings" | "assets" | "components">,
): ResolvedBindingNode[] {
  // Build a Map<componentBindingId, ObjectBinding> filtered to this
  // sceneObject — the renderer composes baseline + delta per binding
  // at draw time via _effectiveTransform.
  const overrides = new Map<string, ObjectBinding>();
  if (sceneObject) {
    for (const ob of scene.objectBindings ?? []) {
      if (ob.objectId === sceneObject.id) {
        overrides.set(ob.componentBindingId, ob);
      }
    }
  }
  return _resolveLevel(
    rootBindingsOf(component.id, scene),
    component.id,
    overrides,
    scene,
    new Set([component.id]),
  );
}


/** Every Asset3D referenced anywhere in a Component's binding tree, in
 *  tree order (roots by sortOrder, then depth-first through children and
 *  sub-Components), deduped by asset id.
 *
 *  Where ``primaryAsset`` answers "what is the MAIN geometry" — and gives
 *  up (null) the moment a Component has more than one root — this answers
 *  "what geometry does this Component CONSIST OF", and never gives up.
 *  Callers that aggregate per-asset data rather than pick a body should
 *  use this one; anchors above all, since a composite Component spreads
 *  its anchors across roots and asking primaryAsset for them silently
 *  yields nothing (the EOSpace EOM, whose RF IN lives on the modulator
 *  root while two FC/APC connectors sit alongside it, was exactly that).
 *
 *  Transform-free by construction: this is the "which assets" question,
 *  so it walks the resolved tree and keeps only the targets. Callers that
 *  need poses want ``resolveBindingTree`` directly.
 */
export function assetsInBindingTree(
  component: ComponentItem,
  scene: Pick<SceneData, "componentBindings" | "objectBindings" | "assets" | "components">,
): Asset3D[] {
  const out: Asset3D[] = [];
  const seen = new Set<string>();
  const visit = (nodes: ResolvedBindingNode[]): void => {
    for (const node of nodes) {
      if (node.target.kind === "asset" && !seen.has(node.target.asset.id)) {
        seen.add(node.target.asset.id);
        out.push(node.target.asset);
      }
      visit(node.children);
    }
  };
  // sceneObject=null: per-instance pose overrides are irrelevant to a
  // question about identity, and skipping them keeps the call sites free
  // of an objectBindings dependency they would otherwise need.
  visit(resolveBindingTree(component, null, scene));

  // Legacy pre-binding Component: the asset hangs off the row itself.
  if (out.length === 0 && component.asset3dId) {
    const legacy = scene.assets.find((a) => a.id === component.asset3dId);
    if (legacy) out.push(legacy);
  }
  return out;
}


/** One anchor of a Component, together with the Asset3D that owns it —
 *  the pair every anchor consumer needs, since resolving an anchor's
 *  frame (``anchorObjectLocalPos`` / ``anchorObjectLocalPrimaryDir``)
 *  takes the owning asset. */
export type OwnedAnchor = { asset: Asset3D; anchor: Anchor };


/** Look up one anchor by the identity an RfLink stores — ``anchorId`` plus
 *  the display ``anchorName`` (``anchor.name ?? anchor.id``) — anywhere in
 *  a Component's binding tree.
 *
 *  The `primaryAsset(comp)?.anchors.find(...)` idiom this replaces returns
 *  null for a multi-root Component (the EOSpace EOM: modulator root plus
 *  two FC/APC connector roots), so its ``rf_in`` was invisible to every
 *  caller even though the RF Link panel — which already aggregates the
 *  tree — offered the port. Tree order, first match wins, matching the
 *  panel's dedupe.
 *
 *  Caveat: the anchor is returned as stored, i.e. in ITS OWN asset's body
 *  frame. That equals the Component body frame only for a root binding at
 *  the identity transform, which is where the device-level ports
 *  (rf_in / rf_out / intercept_*) live. A caller that resolves anchors on
 *  transformed child bindings must fold in ``resolveBindingTree``'s pose
 *  itself.
 */
export function findAnchorInBindingTree(
  component: ComponentItem,
  scene: Pick<SceneData, "componentBindings" | "objectBindings" | "assets" | "components">,
  anchorId: string,
  anchorName: string,
): OwnedAnchor | null {
  for (const asset of assetsInBindingTree(component, scene)) {
    for (const anchor of asset.anchors ?? []) {
      if (anchor.id === anchorId && (anchor.name ?? anchor.id) === anchorName) {
        return { asset, anchor };
      }
    }
  }
  return null;
}


/** Every anchor in a Component's binding tree paired with its owning
 *  asset, deduped by ``anchorId|anchorName`` (the port identity), first
 *  occurrence winning. The list form of ``findAnchorInBindingTree`` — for
 *  callers that scan for anchors by role rather than by name. Same body-frame
 *  caveat applies.
 */
export function anchorsInBindingTree(
  component: ComponentItem,
  scene: Pick<SceneData, "componentBindings" | "objectBindings" | "assets" | "components">,
): OwnedAnchor[] {
  const out: OwnedAnchor[] = [];
  const seen = new Set<string>();
  for (const asset of assetsInBindingTree(component, scene)) {
    for (const anchor of asset.anchors ?? []) {
      const key = `${anchor.id}|${anchor.name ?? anchor.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ asset, anchor });
    }
  }
  return out;
}


/** For a cable Component (kind_id 'fiber' / 'rf_cable') whose binding tree
 *  references two connector Asset3Ds (one per end), derive the
 *  spline-renderer properties so the spline draws the bound connector at
 *  each end. The cable itself renders procedurally (its kindId spline
 *  branch in loadAssetObject), so the connector bindings are DATA — which
 *  connector asset goes at end A / end B — not separately-rendered nodes.
 *
 *  Returns null when fewer than two connector-asset bindings exist; the
 *  caller then falls back to the Component's own `properties`
 *  (fiberKindParamsOverride / endAConnector — the single-binding preset
 *  cables use that path).
 *
 *  End A / B order: `binding.properties.splineEnd` "A" / "B" when set,
 *  else ascending `sortOrder`. */
export function deriveCablePropsFromConnectorBindings(
  component: ComponentItem,
  scene: Pick<SceneData, "componentBindings" | "assets">,
): Record<string, unknown> | null {
  const assetById = new Map((scene.assets ?? []).map((a) => [a.id, a]));
  const isConnector = (id: string | null): boolean => {
    const k = id ? assetById.get(id)?.kindId : null;
    return k === "fiber_connector" || k === "rf_cable_connector";
  };
  const conn = (scene.componentBindings ?? []).filter(
    (b) => b.componentId === component.id && b.targetKind === "asset" && isConnector(b.asset3dId),
  );
  if (conn.length < 2) return null;

  const endRank = (b: ComponentBinding): number => {
    const e = (b.properties as { splineEnd?: string } | undefined)?.splineEnd;
    return e === "A" ? 0 : e === "B" ? 1 : 2;
  };
  const sorted = [...conn].sort(
    (x, y) => endRank(x) - endRank(y) || (x.sortOrder ?? 0) - (y.sortOrder ?? 0),
  );
  const aAsset = assetById.get(sorted[0].asset3dId ?? "");
  const bAsset = assetById.get(sorted[1].asset3dId ?? "");
  if (!aAsset || !bAsset) return null;
  const dpA = (aAsset.defaultParams ?? {}) as Record<string, unknown>;
  const dpB = (bAsset.defaultParams ?? {}) as Record<string, unknown>;

  if (component.kindId === "fiber") {
    return {
      fiberKindParamsOverride: {
        fiberType:
          (dpA.fiberType as string) ?? (dpB.fiberType as string) ?? "polarization_maintaining",
        endA: { polish: (dpA.polish as string) ?? "PC" },
        endB: { polish: (dpB.polish as string) ?? "PC" },
      },
    };
  }
  // rf_cable — endAConnector / endBConnector are the gendered tokens the
  // cable spline normalises (e.g. "sma_male").
  const tok = (dp: Record<string, unknown>): string =>
    `${(dp.family as string) ?? "sma"}_${(dp.gender as string) ?? "male"}`;
  return { endAConnector: tok(dpA), endBConnector: tok(dpB) };
}


function _resolveLevel(
  bindings: ComponentBinding[],
  ownerComponentId: string,
  overrides: Map<string, ObjectBinding>,
  scene: Pick<SceneData, "componentBindings" | "assets" | "components">,
  visited: Set<string>,
): ResolvedBindingNode[] {
  const out: ResolvedBindingNode[] = [];
  for (const binding of bindings) {
    const target = _resolveTarget(binding, scene);
    const objectBinding = overrides.get(binding.id);
    const localTransform = _effectiveTransform(binding, objectBinding);

    // Recurse into THIS Component's children of the current binding...
    const childBindings = childrenOf(binding, scene);
    let children = _resolveLevel(
      childBindings,
      ownerComponentId,
      overrides,
      scene,
      visited,
    );

    // ...AND when this binding points at a sub-Component, splice its
    // own root bindings in as additional children. Sub-Component
    // overrides do NOT carry over (no per-instance state at the
    // sub-Component level — those are baked-in catalog templates).
    if (target.kind === "subcomponent" && !visited.has(target.component.id)) {
      const nextVisited = new Set(visited);
      nextVisited.add(target.component.id);
      const subRoots = rootBindingsOf(target.component.id, scene);
      const subChildren = _resolveLevel(
        subRoots,
        target.component.id,
        new Map(),
        scene,
        nextVisited,
      );
      children = [...children, ...subChildren];
    }

    out.push({ binding, target, localTransform, children });
  }
  return out;
}


/** A "link group" lets several sibling bindings move as one unit when
 *  the user adjusts a single slider — e.g. an isolator's
 *  `front_glan_laser` + `front_piece` both rotate together when the
 *  user drags the "Front" slider. Convention:
 *
 *    binding.properties.linkGroup: string
 *
 *  Bindings without the field stand on their own. The UI groups
 *  bindings by this value and writes the SAME override delta to every
 *  binding in a group simultaneously, so the rotation/translation
 *  stays synchronised across the group.
 *
 *  Read here keeps the convention in one place; downstream callers
 *  (BindingTreeAdjustControls) use it to render the panel layout.
 */
export function bindingLinkGroup(binding: ComponentBinding): string | null {
  const v = (binding.properties as { linkGroup?: unknown } | null | undefined)?.linkGroup;
  return typeof v === "string" && v.length > 0 ? v : null;
}


/** Group a component's bindings by their declared linkGroup. Bindings
 *  without a linkGroup land in their own single-entry group (keyed by
 *  the binding's role_label, or its id as a last resort).
 *
 *  Returns groups in stable insertion order — caller renders sliders
 *  in that order. */
export function groupBindingsByLink(
  bindings: ComponentBinding[],
): Map<string, ComponentBinding[]> {
  const out = new Map<string, ComponentBinding[]>();
  for (const b of bindings) {
    const link = bindingLinkGroup(b);
    if (link !== null) {
      const existing = out.get(link);
      if (existing) existing.push(b);
      else out.set(link, [b]);
      continue;
    }
    const roleLabel = (b.properties as { role_label?: unknown } | null | undefined)?.role_label;
    // Prefer the human role_label; fall back to the binding's `role`
    // (real composites like IO-3-850-HP leave role_label empty but carry a
    // role such as "io_3_850_hp_front_piece"), and only then the opaque id —
    // otherwise the adjustment sliders are labelled with a raw UUID.
    const standaloneKey =
      (typeof roleLabel === "string" && roleLabel) || b.role || b.id;
    out.set(standaloneKey, [b]);
  }
  return out;
}


/** Intersection of `tunableAxes` keys across a set of bindings — the
 *  axes that can be uniformly adjusted on every binding in the group.
 *  Used by the generic Object panel to decide which sliders to show
 *  for a link group: if not every binding declares the axis as
 *  tunable, we skip it (writing an override only to some bindings
 *  would visibly desync the group). */
export function commonTunableAxes(
  bindings: ComponentBinding[],
): string[] {
  if (bindings.length === 0) return [];
  const first = bindings[0].tunableAxes ?? {};
  const candidate = Object.keys(first);
  return candidate.filter((axis) => bindings.every((b) => (b.tunableAxes ?? {})[axis] !== undefined));
}


/** One fibre PORT of a pigtailed instrument: the `fiber_connector` binding
 *  that stands in for the device's optical face, resolved down to everything
 *  the align math needs. */
export type PigtailPortBinding = {
  /** End A dresses `intercept_in`, End B `intercept_out`. */
  end: "A" | "B";
  /** The device anchor this connector re-seats — `binding.properties.portAnchor`. */
  portAnchor: "intercept_in" | "intercept_out";
  binding: ComponentBinding;
  connector: Asset3D;
  connectIn: Anchor;
  /** The wire junction the pigtail's last node is welded to. */
  connectOut: Anchor | undefined;
  /** Catalog baseline pose (what the ObjectBinding delta is measured from). */
  basePose: BindingPose;
  /** Baseline + this instance's ObjectBinding delta. */
  effectivePose: BindingPose;
  /** This instance's override row, when one exists. */
  objectBinding: ObjectBinding | undefined;
  /** Ancestor bindings' effective poses, outermost first. Empty for a root. */
  parentChain: BindingPose[];
};


/** The port connectors of a pigtailed instrument, End A first.
 *
 *  A part opts in purely by DATA — binding a `fiber_connector` asset and
 *  tagging the binding `properties.portAnchor` — which is the same signal
 *  the backend's `db_scene_loader._port_connector_anchors` keys off, so the
 *  ends the UI offers to align are exactly the ones whose port the solver
 *  will re-seat. No per-kind code.
 *
 *  Poses are returned as (baseline, effective, parent chain) rather than one
 *  composed matrix because aligning writes an ObjectBinding DELTA, which is
 *  measured against the baseline and must not swallow the parent chain.
 */
export function pigtailPortBindings(
  component: ComponentItem,
  sceneObject: SceneObject | null | undefined,
  scene: Pick<SceneData, "componentBindings" | "objectBindings" | "assets">,
): PigtailPortBinding[] {
  const assetById = new Map((scene.assets ?? []).map((a) => [a.id, a]));
  const bindingById = new Map(
    (scene.componentBindings ?? []).map((b) => [b.id, b]),
  );
  const overrides = new Map<string, ObjectBinding>();
  for (const ob of scene.objectBindings ?? []) {
    if (sceneObject && ob.objectId === sceneObject.id) {
      overrides.set(ob.componentBindingId, ob);
    }
  }
  const baseOf = (b: ComponentBinding): BindingPose => ({
    localXMm: b.localXMm, localYMm: b.localYMm, localZMm: b.localZMm,
    localRxDeg: b.localRxDeg, localRyDeg: b.localRyDeg, localRzDeg: b.localRzDeg,
  });
  const effectiveOf = (b: ComponentBinding): BindingPose => {
    const t = _effectiveTransform(b, overrides.get(b.id));
    return {
      localXMm: t.xMm, localYMm: t.yMm, localZMm: t.zMm,
      localRxDeg: t.rxDeg, localRyDeg: t.ryDeg, localRzDeg: t.rzDeg,
    };
  };

  const out: PigtailPortBinding[] = [];
  for (const binding of scene.componentBindings ?? []) {
    if (binding.componentId !== component.id) continue;
    if (binding.targetKind !== "asset" || !binding.asset3dId) continue;
    const portAnchor = (binding.properties as { portAnchor?: unknown } | undefined)
      ?.portAnchor;
    if (portAnchor !== "intercept_in" && portAnchor !== "intercept_out") continue;
    const connector = assetById.get(binding.asset3dId);
    if (!connector || connector.kindId !== "fiber_connector") continue;
    const connectIn = findMatingFaceAnchor(connector.anchors);
    if (!connectIn) continue;

    // Ancestors, outermost first. A cycle can only come from corrupt data;
    // bail out of the walk rather than spin.
    const parentChain: BindingPose[] = [];
    const seen = new Set<string>([binding.id]);
    let parentId = binding.parentBindingId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = bindingById.get(parentId);
      if (!parent) break;
      parentChain.unshift(effectiveOf(parent));
      parentId = parent.parentBindingId;
    }

    out.push({
      end: portAnchor === "intercept_out" ? "B" : "A",
      portAnchor,
      binding,
      connector,
      connectIn,
      connectOut: findCableRootAnchor(connector.anchors),
      basePose: baseOf(binding),
      effectivePose: effectiveOf(binding),
      objectBinding: overrides.get(binding.id),
      parentChain,
    });
  }
  return out.sort((a, b) => a.end.localeCompare(b.end));
}
