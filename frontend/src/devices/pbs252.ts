import { defineDevice } from "./_device";

/**
 * PBS252-Step — device template (auto-derived from the live `pbs252_step` asset).
 *
 * behavioralKind `beam_splitter`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const pbs252 = defineDevice({
  id: "pbs252",
  displayName: "PBS252-Step",
  behavioralKind: "beam_splitter",
  componentType: "beam_splitter",
  mesh: "pbs252_step.glb",
  anchors: [
    {
      role: "intercept_face",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: -0.7071067811865475, y: 0.7071067811865475, z: 0 },
      axisYBodyLocal: { x: 0.7071067811865475, y: 0.7071067811865475, z: 0 },
      apertureMm: 1,
      apertureShape: "rectangle",
      apertureWidthMm: 35.92,
      apertureHeightMm: 25.4,
    },
  ],
  defaultParams: {
    lengthMm: 25.4,
    polarizing: true,
    refractiveIndex_e: 1.693,
    refractiveIndex_o: 1.693,
    extinctionRatioPpDb: 30,
    extinctionRatioSpDb: 30,
    transmissionAxisDegBeamLocal: 0,
  },
});
