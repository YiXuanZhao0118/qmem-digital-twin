import { defineDevice } from "./_device";

/**
 * dbr_tosa — device template (auto-derived from the live `dbr_tosa` asset).
 *
 * behavioralKind `laser_source`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const dbr_tosa = defineDevice({
  id: "dbr_tosa",
  displayName: "dbr_tosa",
  behavioralKind: "laser_source",
  componentType: "laser_source",
  mesh: "dbr_tosa.glb",
  anchors: [
    {
      role: "intercept_out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 0, y: 1, z: 0 },
      axisYBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 1,
      apertureShape: "circle",
    },
  ],
  defaultParams: {
    mode_index_1: 0,
    mode_index_2: 0,
    nominalPowerMw: 50,
    centerWavelengthNm: 852.347,
  },
});
