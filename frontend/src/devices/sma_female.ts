import { defineDevice } from "./_device";

/**
 * SMA Connector (female) — device template (auto-derived from the live `sma_female` asset).
 *
 * behavioralKind `rf_cable_connector`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const sma_female = defineDevice({
  id: "sma_female",
  displayName: "SMA Connector (female)",
  behavioralKind: "rf_cable_connector",
  componentType: "rf_cable_connector",
  mesh: "sma_female_connector",
  anchors: [
    {
      role: "connect_out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: -1, y: 0, z: 0 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
    },
    {
      role: "connect_in",
      positionMmBodyLocal: { x: 15.5, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
    },
  ],
  defaultParams: {
    maxFreqGhz: 18,
    impedanceOhm: 50,
  },
});
