/**
 * Per-componentType allowlist for the ComponentBinding-tree renderer.
 *
 * The legacy renderer path in DigitalTwinViewer
 * (``loadAssetObject(component, asset, deviceState, props, fiberEnds)``)
 * has deep ties to per-componentType state — fiber's per-instance
 * spline, rf_cable's anchor-linked endpoints, isolator's bespoke
 * pbsOverlay STL-triangle partition. The binding-tree renderer
 * (``buildBindingTreeObject`` over ``resolveBindingTree``) is the
 * long-term replacement but only makes sense for componentTypes whose
 * catalog has actually been migrated to a binding tree (i.e. has
 * ``ComponentBinding`` rows describing the assembly structure).
 *
 * This allowlist is the migration gate. A componentType added here
 * tells DigitalTwinViewer's per-object render block to walk the
 * binding tree instead of calling the legacy single-asset loader.
 * Components NOT in the set keep their existing render path — zero
 * regression for the 280+ catalog rows we haven't touched.
 *
 * Order of migration (each entry = one PR):
 *   - "isolator"      — Stage A'', replaces pbsOverlay.ts
 *   - "mirror_mount"  — Stage D, collapses mirror_mount + mirror
 *   - …
 *
 * Once every componentType uses the binding path, the gate goes away
 * (along with ``Component.asset_3d_id`` — Stage G).
 */
import * as THREE from "three";

import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  SceneData,
  SceneObject,
} from "../types/digitalTwin";
import { resolveBindingTree } from "../utils/componentBindings";
import { loadAssetObject } from "./loadAsset";
import { buildBindingTreeObject } from "./bindingTreeObject";


// Per-componentType force-on (rarely needed once per-Component opt-in
// works). Empty today; keep around so a kind whose data hasn't been
// fully migrated can be temporarily routed through the binding tree
// for testing.
export const RENDER_VIA_BINDINGS: ReadonlySet<string> = new Set<string>([
  // "isolator",  // not flipped here — per-Component opt-in below covers it
  // "mirror_mount",
]);


/** Returns true when this specific Component's render path should walk
 *  the ComponentBinding tree (via ``buildBindingTreeObject``) instead
 *  of the legacy ``loadAssetObject`` single-asset path.
 *
 *  Decision (in order):
 *    1. componentType is in the force-on allowlist → true.
 *    2. Component has any non-root binding in the scene → true. This
 *       is the per-Component opt-in: the alembic data migration that
 *       gives a Component a sub-Component or empty-Mount child binding
 *       (e.g. Stage A''.7's TORNOS-850-4 5-part tree) flips it onto
 *       the binding-tree path automatically. Components whose only
 *       binding is the 0062-backfilled root (single asset) stay on
 *       the legacy path → visual no-op for 500+ catalog rows.
 */
export function shouldRenderViaBindings(
  componentType: string,
  componentId: string,
  scene: Pick<SceneData, "componentBindings">,
): boolean {
  if (RENDER_VIA_BINDINGS.has(componentType)) return true;
  const bindings = scene.componentBindings ?? [];
  for (const b of bindings) {
    if (b.componentId === componentId && b.parentBindingId !== null) {
      return true;
    }
  }
  return false;
}


/** Build the renderable Object3D for a SceneObject by walking its
 *  Component's ComponentBinding tree. Replacement for the legacy
 *  ``loadAssetObject(component, asset, ...)`` single-asset call when
 *  the componentType is allowlisted.
 *
 *  Loader semantics inside the walk:
 *    * ``target.kind === "asset"``        → delegate to ``loadAssetObject``
 *      with the resolved asset. The walker stacks the binding's local
 *      transform on top of whatever wrapper the per-kind loader returns.
 *    * ``target.kind === "subcomponent"`` → emit an empty Group at the
 *      binding's local transform. The walker recurses into the
 *      splice'd sub-Component bindings as children of that empty
 *      Group — no geometry of its own, just a transform parent.
 *    * ``target.kind === "missing"``      → skip the subtree (the data
 *      layer chose to surface this as a soft-fail).
 *
 *  Returns a Group regardless of tree shape so the caller's
 *  ``wrapper.add(...)`` + ``applyObjectGeometryOffset(wrapper, placement)``
 *  pattern stays uniform with the legacy path.
 */
export async function buildSceneObjectFromBindings(
  component: ComponentItem,
  sceneObject: SceneObject | null,
  scene: Pick<SceneData, "componentBindings" | "assets" | "components">,
): Promise<THREE.Object3D> {
  const tree = resolveBindingTree(component, sceneObject, scene);
  // Per-instance binding-override deltas are applied INSIDE
  // resolveBindingTree (via _effectiveTransform) using the standard
  // SceneObject.properties.bindingOverrides[bindingId] path. No
  // component-specific branch here.
  const group = await buildBindingTreeObject(tree, async (node) => {
    if (node.target.kind === "missing") return null;
    if (node.target.kind === "subcomponent" || node.target.kind === "empty") {
      // subcomponent: logical container that recurses into the
      // sub-Component's own root bindings (resolveBindingTree splices
      // them in as children).
      // empty: explicit transform-only node — the user's "PBS Mount"
      // case in the 5-part isolator decomposition. Carries
      // localTransform + tunable_axes, no geometry of its own.
      // Both render as an empty Group that the walker hangs children
      // under, so the parent transform propagates through.
      return new THREE.Group();
    }
    // Asset node — load via the existing per-kind / per-asset loader.
    // ``component`` (the parent Component being rendered) is passed for
    // material + anchor-resolution context; this matches how the
    // legacy single-asset path called loadAssetObject before binding
    // trees existed. Per-instance fiber / rf_cable spline + ferrule
    // state is intentionally NOT forwarded — those are only meaningful
    // for the legacy single-asset path and a composite Component
    // (isolator, mirror_mount, …) never has fiber-style per-instance
    // state on its root.
    return loadAssetObject(component, node.target.asset, undefined, null, null);
  });
  // The walker may produce a Group with one child (legacy single-root
  // case) or many children (composite). Either way the outer Group is
  // the renderable; callers will add it to their wrapper and apply
  // the SceneObject's world pose via ``applyObjectGeometryOffset``.
  group.name = component.name;
  return group;
}


// Re-export ComponentBinding-related helpers so callers only need one
// import to opt in. Wildcards intentionally avoided to keep the
// public surface explicit.
export type {
  Asset3D,
  ComponentBinding,
  SceneObject,
};
