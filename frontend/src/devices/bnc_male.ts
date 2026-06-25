import { defineDevice } from "./_device";

/**
 * BNC Male — device template (auto-derived from the live `bnc_male` asset).
 *
 * behavioralKind `rf_cable_connector`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const bnc_male = defineDevice({
  id: "bnc_male",
  displayName: "BNC Male",
  behavioralKind: "rf_cable_connector",
  componentType: "rf_cable_connector",
  mesh: "bnc_male.glb",
  anchors: [
    {
      role: "connect_out",
      positionMmBodyLocal: { x: 0, y: 0, z: -29.7 },
      directionBodyLocal: { x: 0, y: 0, z: -1 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 0,
      apertureShape: "circle",
    },
    {
      role: "connect_in",
      positionMmBodyLocal: { x: 0, y: 0, z: 13.8 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 0,
      apertureShape: "circle",
    },
  ],
  defaultParams: {
    maxFreqGhz: 4,
    impedanceOhm: 50,
  },
});
