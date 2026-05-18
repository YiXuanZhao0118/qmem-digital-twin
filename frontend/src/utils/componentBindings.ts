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
