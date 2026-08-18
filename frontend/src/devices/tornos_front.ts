import { defineDevice } from "./_device";

/**
 * TORNOS_isolator_front_piece — input-polarizer stage of the EOT/Coherent
 * TORNOS Medium Power Optical Isolator (500–1030 nm). Sibling pieces:
 * `tornos_faraday` (the rod) and `tornos_back` (output polarizer).
 *
 * behavioralKind `isolator`, same shape as `io5_850_front`: the live asset
 * carries no anchors, so this template carries none either and attaching the
 * device is lossless. Isolation / transmission (≈30 dB per isolator, 60 dB
 * for two in series; TORNOS-850-4 is specced 33 dB / ≥95 % T) stay on the
 * COMPONENT — see `backend/scripts/seed.py`'s `isolatorKindParamsOverride`
 * — because neither polarizer piece is traced on its own.
 */
export const tornos_front = defineDevice({
  id: "tornos_front",
  displayName: "TORNOS_isolator_front_piece",
  behavioralKind: "isolator",
  componentType: "isolator",
  mesh: "tornos_isolator_front_piece.glb",
  anchors: [],
});
