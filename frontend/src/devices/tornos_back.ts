import { defineDevice } from "./_device";

/**
 * TORNOS_isolator_back_piece — output-polarizer stage of the EOT/Coherent
 * TORNOS Medium Power Optical Isolator (500–1030 nm). Crossed at 45° to the
 * input polarizer, so the rod's non-reciprocal 45° passes forward and the
 * 90° round trip is rejected. Sibling pieces: `tornos_front`,
 * `tornos_faraday`.
 *
 * behavioralKind `isolator`, same shape as `io5_850_back`: the live asset
 * carries no anchors, so this template carries none either and attaching the
 * device is lossless. Isolation / transmission numbers stay on the
 * COMPONENT (see `tornos_front`).
 */
export const tornos_back = defineDevice({
  id: "tornos_back",
  displayName: "TORNOS_isolator_back_piece",
  behavioralKind: "isolator",
  componentType: "isolator",
  mesh: "tornos_isolator_back_piece.glb",
  anchors: [],
});
