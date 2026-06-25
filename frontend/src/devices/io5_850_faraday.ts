import { defineDevice } from "./_device";

/**
 * IO-5-850-HP-Faraday-Rod — device template (auto-derived from the live `io_5_850_hp_middle_piece` asset).
 *
 * behavioralKind `faraday_rotator`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const io5_850_faraday = defineDevice({
  id: "io5_850_faraday",
  displayName: "IO-5-850-HP-Faraday-Rod",
  behavioralKind: "faraday_rotator",
  componentType: "faraday_rotator",
  mesh: "io_5_850_hp_middle_piece.glb",
  anchors: [
    {
      role: "optical_center",
      positionMmBodyLocal: { x: 0, y: 0, z: -47.752 },
      directionBodyLocal: { x: 0, y: 0, z: -1 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 12.5,
      apertureShape: "circle",
    },
  ],
  defaultParams: {
    lengthMm: 18,
    reciprocal: false,
    arResidualR: 0.005,
    rotationDeg: 45,
    refractiveIndex: 1.95,
    VerdetConstantRadPerTeslaMm: 0.0427,
  },
});
