import { defineDevice } from "./_device";

/**
 * IO-5-850-HP-front — device template (auto-derived from the live `io_5_850_hp_front_piece` asset).
 *
 * behavioralKind `isolator`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const io5_850_front = defineDevice({
  id: "io5_850_front",
  displayName: "IO-5-850-HP-front",
  behavioralKind: "isolator",
  componentType: "isolator",
  mesh: "io_5_850_hp_front_piece.glb",
  anchors: [],
});
