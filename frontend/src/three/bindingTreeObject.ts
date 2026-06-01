/**
 * Walk a ResolvedBindingNode tree and build a composite THREE.Object3D.
 *
 * Stage A''' helper — sits between the data-only ``resolveBindingTree``
 * (utils/componentBindings.ts) and the renderer's per-asset loader.
 * The renderer passes a ``BindingLoader`` callback that knows how to
 * load a single asset / sub-component into an Object3D (typically
 * wrapping the existing ``loadAssetObject``); the walker handles the
 * tree traversal + local-transform composition + parent-child wiring.
 *
 * For the 518 components backfilled by alembic 0062 (single root,
 * target_kind="asset", identity transform), this produces a Group with
 * one child at the origin — visually identical to the legacy
 * ``loadAssetObject(component, asset, ...)`` path. Composite bindings
 * (isolator, mirror_mount, …) fan out with each child positioned by
 * its declared local transform.
 *
 * Frame contract
 * --------------
 * Binding's local transform positions a child asset within the PARENT's
 * CAD frame — the SAME frame the loaded meshes live in (loadAssetObject
 * scales STL/procedural geometry to mm/100 but does NOT swap axes). So
 * the binding pose is applied RAW: per-axis /100 scale, no lab→three
 * y↔z swap, XYZ Euler. The SceneObject's pose (applyObjectTransform via
 * sceneObjectToQuaternion) then converts the whole assembled tree from
 * CAD frame to lab/three in one step.
 *
 * ⚠️ Earlier this used ``labMmToThree`` (which y↔z-swaps) + a YXZ Euler
 * "to match sceneObjectToQuaternion". That put binding POSITIONS in
 * three's Y-up frame while the meshes they position stayed in CAD frame
 * → composite pieces scattered onto the wrong axis (IO-3-850-HP glans
 * flew off perpendicular to the housing). Raw composition matches
 * ComponentsEditor's ``poseFromBinding`` (the editor the user tunes
 * against) AND the backend solver's raw binding composition.
 */
import * as THREE from "three";

import { mmToThree } from "../optical/frames";
import type { ResolvedBindingNode } from "../utils/componentBindings";


/** Async callback the renderer supplies to convert one binding node
 *  into a renderable Object3D. Should ignore ``children`` — the walker
 *  handles recursion on its own and wires the result as a child group.
 *  Returning ``null`` skips this node + its subtree (the caller chose
 *  not to render it; missing-target nodes typically fall here). */
export type BindingLoader = (
  node: ResolvedBindingNode,
) => Promise<THREE.Object3D | null>;


/** Build the THREE.Group representing this tree. Returns a Group even
 *  when there are no nodes — keeps the caller's add-to-scene path
 *  uniform. */
export async function buildBindingTreeObject(
  nodes: readonly ResolvedBindingNode[],
  loader: BindingLoader,
): Promise<THREE.Group> {
  const parent = new THREE.Group();
  for (const node of nodes) {
    const content = await loader(node);
    if (content === null) continue;

    const pivot = new THREE.Group();
    pivot.name = content.name || node.binding.id;
    applyBindingLocalTransform(pivot, node);
    pivot.add(content);

    // Recurse into children — each becomes a sub-group attached to
    // the binding pivot so asset-root corrections do not affect them.
    if (node.children.length > 0) {
      const childGroup = await buildBindingTreeObject(node.children, loader);
      childGroup.userData.__bindingChildrenOf = node.binding.id;
      pivot.add(childGroup);
    }

    pivot.userData.__bindingId = node.binding.id;
    content.userData.__bindingId = node.binding.id;
    parent.add(pivot);
  }
  return parent;
}


/** Apply a binding's effective local transform (post-override) to a
 *  THREE.Object3D, in the parent's CAD frame (no lab→three swap). Per-
 *  axis /100 scale matches the meshes (loadAssetObject's mm/100); the
 *  RAW XYZ Euler matches ComponentsEditor's poseFromBinding so the
 *  Component editor preview and the lab viewer compose pieces
 *  identically. The SceneObject pose converts the assembled tree to
 *  lab/three afterwards. */
export function applyBindingLocalTransform(
  obj: THREE.Object3D,
  node: ResolvedBindingNode,
): void {
  const t = node.localTransform;
  obj.position.set(mmToThree(t.xMm), mmToThree(t.yMm), mmToThree(t.zMm));
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(t.rxDeg),
    THREE.MathUtils.degToRad(t.ryDeg),
    THREE.MathUtils.degToRad(t.rzDeg),
    "XYZ",
  );
  obj.quaternion.setFromEuler(euler);
}
