import type * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../types/digitalTwin";
import { createAaoptoelectronicMt80 } from "./models/aaoptoelectronic_mt80";

/** AOM model dispatcher. Until a non-MT80 model lands, every AOM
 *  catalog row falls through to the AAOptoelectronic MT80 procedural
 *  geometry. Add a new model = drop a file in `./models/<brand>_<part>.ts`,
 *  add a case here keyed on `component.model`. The renderer name
 *  `createAom` is preserved for backwards-compat with the barrel
 *  re-exports in `three/loadAsset/index.ts`. */
export function createAom(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  // Single-model dispatcher today — extension point for ADM-80 / etc.
  return createAaoptoelectronicMt80(component, state);
}
