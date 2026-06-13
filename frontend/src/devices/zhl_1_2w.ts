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
  anchors: [
    { role: "rf_in", connectorType: "sma_female", directionBodyLocal: { x: -1, y: 0, z: 0 } },
    { role: "rf_out", connectorType: "sma_female", directionBodyLocal: { x: 1, y: 0, z: 0 } },
  ],
});
