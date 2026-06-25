import { defineDevice } from "./_device";

/**
 * Glan-Laser Prism (IO-3-850-HP, L=5.0mm) — device template (auto-derived from the live `glan_laser_io3_850` asset).
 *
 * behavioralKind `beam_splitter`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const glan_io3_850 = defineDevice({
  id: "glan_io3_850",
  displayName: "Glan-Laser Prism (IO-3-850-HP, L=5.0mm)",
  behavioralKind: "beam_splitter",
  componentType: "beam_splitter",
  mesh: "glan_polarizer_prism",
  anchors: [
    {
      role: "intercept_face",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 0.6225096458616945, y: 0, z: -0.7826121266688548 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 3,
      apertureShape: "rectangle",
    },
  ],
  defaultParams: {
    lengthMm: 5,
    polarizing: true,
    refractiveIndex_e: 1.48,
    refractiveIndex_o: 1.66,
    extinctionRatioPpDb: 50,
    extinctionRatioSpDb: 30,
    transmissionAxisDegBeamLocal: 0,
  },
});
