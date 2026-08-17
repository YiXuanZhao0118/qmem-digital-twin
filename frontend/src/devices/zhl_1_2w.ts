import { defineDevice } from "./_device";

/**
 * Mini-Circuits ZHL-1-2W+ — coaxial RF power amplifier.
 *
 * Device example for the `rf_amplifier` behavioral kind. Two SMA-F ports;
 * gain / P1dB live in the behavioral kind's defaultParams (this part's
 * +29 dB / +30 dBm match the kind defaults, so no per-device override).
 * Anchors seed at the body origin (no measured coordinates yet) — the user
 * drags rf_in / rf_out onto the real connectors in the PHY Editor; both are
 * outward face normals.
 */
export const zhl_1_2w = defineDevice({
  id: "zhl_1_2w",
  displayName: "Mini-Circuits ZHL-1-2W+ (RF amp)",
  behavioralKind: "rf_amplifier",
  componentType: "rf_amplifier",
  mesh: "primitive://rf_amplifier",
  // Positions synced 2026-08-17 from the locked
  // `minicircuits_zhl_1_2w_plus` Asset3D row and verified against the GLB
  // it renders (42c2b987…_minicircuits_zhl_1_2w_plus.glb): walking inward
  // along x, the housing ends at 44.5, there is a recess with no geometry
  // from 44.5 to 47.0, and the connector body runs 47.0 → 55.5. So x =
  // 47.2 is the connector's rear face, and the transverse centroid through
  // that whole region is (0.000, 0.000) — the connector axis.
  anchors: [
    {
      role: "rf_in",
      positionMmBodyLocal: { x: -47.2, y: 0, z: 0 },
      directionBodyLocal: { x: -1, y: 0, z: 0 },
      connectorType: "sma_female",
    },
    {
      role: "rf_out",
      positionMmBodyLocal: { x: 47.2, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      connectorType: "sma_female",
    },
  ],
});
