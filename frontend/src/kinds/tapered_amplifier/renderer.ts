import type * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../types/digitalTwin";
import { createGenericTaperedAmplifierChip } from "./models/generic_chip";
import { createTopticaBoostaPro } from "./models/toptica_boosta_pro";

/** Tapered-amplifier model dispatcher. `geometry === "boosta_pro_module"`
 *  picks the TOPTICA BoosTA pro housing; everything else falls through
 *  to the generic bare-chip primitive. New TA modules (Sacher, ALPHALAS…)
 *  drop a file in `./models/<brand>_<part>.ts` and add a case here. */
export function createTaperedAmplifier(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  const geometry = (component.properties as { geometry?: string } | undefined)?.geometry;
  if (geometry === "boosta_pro_module") {
    return createTopticaBoostaPro(component, state);
  }
  return createGenericTaperedAmplifierChip(component, state);
}
