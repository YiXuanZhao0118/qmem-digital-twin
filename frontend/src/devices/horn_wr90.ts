import { defineDevice } from "./_device";

/**
 * WR-90 microwave horn antenna — radiating aperture.
 *
 * Device example for the `horn_antenna` behavioral kind. A single
 * `aperture` role is the radiating mouth; the chain output leaves along the
 * polar axis (kindParam `polarAxisBodyLocal`, +Z body-local default) with a
 * cos^n lobe. Anchor seeds at origin, dragged onto the horn mouth.
 */
export const horn_wr90 = defineDevice({
  id: "horn_wr90",
  displayName: "WR-90 microwave horn",
  behavioralKind: "horn_antenna",
  componentType: "horn_antenna",
  mesh: "primitive://horn_antenna",
  anchors: [
    { role: "aperture", directionBodyLocal: { x: 0, y: 0, z: 1 } },
  ],
});
