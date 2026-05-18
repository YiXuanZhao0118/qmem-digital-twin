import type * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../types/digitalTwin";
import { createMinicircuitsZyswa250dr } from "./models/minicircuits_zyswa_2_50dr";

/** rf_switch model dispatcher. Single model today; add new switches by
 *  dropping `./models/<brand>_<part>.ts` and branching on
 *  `component.model`. The renderer name `createRfSwitch` is preserved
 *  for backwards-compat with the barrel re-exports. */
export function createRfSwitch(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  return createMinicircuitsZyswa250dr(component, state);
}
