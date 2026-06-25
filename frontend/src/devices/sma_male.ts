import { defineDevice } from "./_device";

/**
 * sma male — device template (auto-derived from the live `sma_male` asset).
 *
 * behavioralKind `rf_cable_connector`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const sma_male = defineDevice({
  id: "sma_male",
  displayName: "sma male",
  behavioralKind: "rf_cable_connector",
  componentType: "rf_cable_connector",
  mesh: "sma_male.glb",
  anchors: [
    {
      role: "connect_out",
      positionMmBodyLocal: { x: -4, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 0,
      apertureShape: "circle",
    },
    {
      role: "connect_in",
      positionMmBodyLocal: { x: -29.45, y: 0, z: 0 },
      directionBodyLocal: { x: -1, y: 0, z: 0 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 0,
      apertureShape: "circle",
    },
  ],
  defaultParams: {
    maxFreqGhz: 18,
    impedanceOhm: 50,
  },
});
