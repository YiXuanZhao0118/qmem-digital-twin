import { defineDevice } from "./_device";

/**
 * toptica_boosta_pro — device template (auto-derived from the live `toptica_boosta_pro` asset).
 *
 * behavioralKind `tapered_amplifier`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const toptica_boosta_pro = defineDevice({
  id: "toptica_boosta_pro",
  displayName: "toptica_boosta_pro",
  behavioralKind: "tapered_amplifier",
  componentType: "tapered_amplifier",
  mesh: "toptica_boosta_pro.glb",
  anchors: [
    {
      role: "intercept_in",
      positionMmBodyLocal: { x: 141.85, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 1,
      apertureShape: "circle",
    },
    {
      role: "intercept_out",
      positionMmBodyLocal: { x: -141.85, y: 0, z: 0 },
      directionBodyLocal: { x: -1, y: 0, z: 0 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 1,
      apertureShape: "circle",
    },
  ],
  defaultParams: {
    maxInputPowerMw: 30,
    minInputPowerMw: 10,
    saturationPowerMw: 500,
    smallSignalGainDb: 30,
    centerWavelengthNm: 780,
    inputAcceptanceRadiusMm: 25,
  },
});
