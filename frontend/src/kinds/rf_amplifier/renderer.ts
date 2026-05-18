import type * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../types/digitalTwin";
import { createMinicircuitsZhl12wPlus } from "./models/minicircuits_zhl_1_2w_plus";

/** rf_amplifier model dispatcher. Today only the Mini-Circuits ZHL-1-2W+
 *  has a procedural model; other amplifier brands/models fall through to
 *  the generic chassis box wired in `_renderer_bindings.ts:renderRfAmplifier`,
 *  so this dispatcher is the "known-good model wins" branch. The renderer
 *  name `createZhl12wPlusAmplifier` is preserved for backwards-compat
 *  with the barrel re-exports. */
export function createZhl12wPlusAmplifier(
  component: ComponentItem,
  state?: DeviceState,
): THREE.Object3D {
  return createMinicircuitsZhl12wPlus(component, state);
}
