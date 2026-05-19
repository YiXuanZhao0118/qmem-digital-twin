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
  Asset3D,
  ComponentBinding,
  ComponentItem,
  SceneData,
  SceneObject,
} from "../types/digitalTwin";


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
  scene: Pick<SceneData, "componentBindings">,
): ComponentBinding[] {
  const all = scene.componentBindings ?? [];
  return all.filter((b) => b.componentId === componentId);
}


/** Top-level bindings of a Component (parentBindingId === null). A
 *  Component usually has one root, but multi-root is legal (no single
 *  anchoring body). */
export function rootBindingsOf(
  componentId: string,
  scene: Pick<SceneData, "componentBindings">,
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
  scene: Pick<SceneData, "componentBindings" | "assets">,
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
   *  merged with any per-instance ``SceneObject.properties.bindingOverrides``
   *  entry for this binding. Override values take precedence per axis. */
  localTransform: ResolvedLocalTransform;
  children: ResolvedBindingNode[];
};


function _effectiveTransform(
  binding: ComponentBinding,
  override: Record<string, number> | null,
): ResolvedLocalTransform {
  // Override may set any subset of axes; missing axes keep the
  // binding's declared default. Override values are interpreted in the
  // frame declared by binding.tunableAxes — the renderer applies the
  // frame mapping after this function returns since frame semantics
  // depend on the surrounding tree state.
  const v = (key: keyof ResolvedLocalTransform, fallback: number): number => {
    if (!override) return fallback;
    const raw = override[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  };
  return {
    xMm: v("xMm", binding.localXMm),
    yMm: v("yMm", binding.localYMm),
    zMm: v("zMm", binding.localZMm),
    rxDeg: v("rxDeg", binding.localRxDeg),
    ryDeg: v("ryDeg", binding.localRyDeg),
    rzDeg: v("rzDeg", binding.localRzDeg),
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
  scene: Pick<SceneData, "componentBindings" | "assets" | "components">,
): ResolvedBindingNode[] {
  const overrides =
    sceneObject?.properties as Record<string, unknown> | undefined;
  return _resolveLevel(
    rootBindingsOf(component.id, scene),
    component.id,
    overrides,
    scene,
    new Set([component.id]),
  );
}


function _resolveLevel(
  bindings: ComponentBinding[],
  ownerComponentId: string,
  overrides: Record<string, unknown> | undefined,
  scene: Pick<SceneData, "componentBindings" | "assets" | "components">,
  visited: Set<string>,
): ResolvedBindingNode[] {
  const out: ResolvedBindingNode[] = [];
  for (const binding of bindings) {
    const target = _resolveTarget(binding, scene);
    const override = bindingOverrideFor(binding.id, overrides);
    const localTransform = _effectiveTransform(binding, override);

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
        undefined,
        scene,
        nextVisited,
      );
      children = [...children, ...subChildren];
    }

    out.push({ binding, target, localTransform, children });
  }
  return out;
}


/** Read a per-instance pose override from a SceneObject's properties
 *  for a given binding. Returns the overlay dict (e.g. ``{rzDeg: 1.7}``)
 *  or null when the SceneObject has no overrides for that binding.
 *
 *  The shape on the SceneObject is
 *  ``properties.bindingOverrides[<bindingId>] = { rxDeg?, ryDeg?,
 *  rzDeg?, xMm?, yMm?, zMm? }``. Renderer composes
 *  effective = binding.local* + override.* per-axis at draw time.
 */
export function bindingOverrideFor(
  bindingId: string,
  sceneObjectProperties: Record<string, unknown> | undefined | null,
): Record<string, number> | null {
  if (!sceneObjectProperties) return null;
  const overrides = sceneObjectProperties.bindingOverrides;
  if (!overrides || typeof overrides !== "object") return null;
  const entry = (overrides as Record<string, unknown>)[bindingId];
  if (!entry || typeof entry !== "object") return null;
  return entry as Record<string, number>;
}
