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


// Empty by default — every componentType currently goes through the
// legacy ``loadAssetObject`` path. Adding "isolator" here is the
// switch-flip for Stage A''; the visual diff between the bespoke
// pbsOverlay path and the binding-tree path is the test that the
// migration succeeded.
export const RENDER_VIA_BINDINGS: ReadonlySet<string> = new Set<string>([
  // "isolator",
  // "mirror_mount",
]);


/** Returns true when ``componentType``'s render path should walk the
 *  ComponentBinding tree (via ``buildBindingTreeObject``) instead of
 *  the legacy ``loadAssetObject`` single-asset path. */
export function shouldRenderViaBindings(componentType: string): boolean {
  return RENDER_VIA_BINDINGS.has(componentType);
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
