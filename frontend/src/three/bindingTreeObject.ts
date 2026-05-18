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
 * Binding's local transform is body-local Z-up mm + XYZ-order Euler
 * degrees (same convention as SceneObject's pose fields). This module
 * converts to three's Y-up mm/100 frame using the same mapping as
 * ``frames.ts::labMmToThree`` / ``sceneObjectToQuaternion`` so the
 * tree composes correctly with the rest of the renderer's math.
 */
import * as THREE from "three";

import { labMmToThree } from "../optical/frames";
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
    const loaded = await loader(node);
    if (loaded === null) continue;

    applyBindingLocalTransform(loaded, node);

    // Recurse into children — each becomes a sub-group attached to
    // ``loaded`` so their transforms stack on top of this node's pose.
    if (node.children.length > 0) {
      const childGroup = await buildBindingTreeObject(node.children, loader);
      childGroup.userData.__bindingChildrenOf = node.binding.id;
      loaded.add(childGroup);
    }

    loaded.userData.__bindingId = node.binding.id;
    parent.add(loaded);
  }
  return parent;
}


/** Apply a binding's effective local transform (post-override) to a
 *  THREE.Object3D. Position is body-local mm → three units via the
 *  standard frames mapping; rotation uses the same YXZ Euler order as
 *  ``sceneObjectToQuaternion`` so child transforms compose with the
 *  parent's pose without surprises. */
export function applyBindingLocalTransform(
  obj: THREE.Object3D,
  node: ResolvedBindingNode,
): void {
  const t = node.localTransform;
  const pos = labMmToThree({ xMm: t.xMm, yMm: t.yMm, zMm: t.zMm });
  obj.position.copy(pos);
  // YXZ ordering with rx → three.x, rz → three.y, -ry → three.z
  // matches frames.ts::sceneObjectToQuaternion. The binding's body
  // frame and a SceneObject's body frame share the same convention,
  // so the same Euler composition applies.
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(t.rxDeg),
    THREE.MathUtils.degToRad(t.rzDeg),
    THREE.MathUtils.degToRad(-t.ryDeg),
    "YXZ",
  );
  obj.quaternion.setFromEuler(euler);
}
