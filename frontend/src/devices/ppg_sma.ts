import { defineDevice } from "./_device";

/**
 * Generic SMA programmable pulse generator — TTL/Trigger output channel.
 *
 * Device example for the `programmable_pulse_generator` behavioral kind.
 * One coax rf_out emitting the bound TimingProgram's gate (the RF-Link
 * panel renders it as the "rfout" gate domain regardless of role domain).
 * BNC variants differ only by `connectorType`. Anchor seeds at origin.
 */
export const ppg_sma = defineDevice({
  id: "ppg_sma",
  displayName: "PPG (SMA, TTL/Trigger out)",
  behavioralKind: "programmable_pulse_generator",
  componentType: "programmable_pulse_generator",
  mesh: "primitive://programmable_pulse_generator",
  anchors: [
    { role: "rf_out", connectorType: "sma_female", directionBodyLocal: { x: 1, y: 0, z: 0 } },
  ],
});
