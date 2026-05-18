import * as THREE from "three";

import type { Asset3D, ComponentItem, DeviceState } from "../../types/digitalTwin";
import { pluginForComponentType } from "../../kinds/_plugins";
import { createBox } from "./materials";

/** Dispatch entry for components that render through a procedural primitive
 *  (no STL/GLB on disk). Looks up the plugin's renderer (bound centrally in
 *  `kinds/_renderer_bindings.ts` for legacy entries, or declared directly in
 *  each plugin's `index.ts` after the M6 migration), and falls back to a
 *  generic 100×100×80 mm box if no renderer is registered for the type. */
export function createPrimitive(
  component: ComponentItem,
  state?: DeviceState,
  asset?: Asset3D | null,
): THREE.Object3D {
  const group = new THREE.Group();
  group.name = component.name;

  const plugin = pluginForComponentType(component.componentType);
  let mesh: THREE.Object3D;
  if (plugin?.renderer) {
    mesh = plugin.renderer(component, state, asset ?? undefined);
  } else {
    mesh = createBox(component, state, [100, 100, 80]);
    mesh.position.y = 0.2;
  }

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

export function applyAssetScale(object: THREE.Object3D, asset: Asset3D): void {
  const unitScale = asset.unit === "m" ? 10 : 1 / 100;
  object.scale.multiplyScalar(asset.scaleFactor * unitScale);
}
