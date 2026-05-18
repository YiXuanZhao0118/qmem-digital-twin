import type * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../types/digitalTwin";
import { createAnalogDevicesAd9959Pcbz } from "./models/analog_devices_ad9959_pcbz";

/** rf_source / dds_ad9959_pcb model dispatcher. Today the only
 *  procedural model is the Analog Devices AD9959/PCBZ evaluation board;
 *  the legacy `createDdsAd9959Pcb` name is preserved as the public
 *  export so the barrel re-exports keep working. */
export function createDdsAd9959Pcb(component: ComponentItem, state?: DeviceState): THREE.Object3D {
  return createAnalogDevicesAd9959Pcbz(component, state);
}
