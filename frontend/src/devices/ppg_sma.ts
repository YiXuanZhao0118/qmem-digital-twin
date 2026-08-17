import { defineDevice } from "./_device";

/**
 * Generic SMA programmable pulse generator — TTL/Trigger output channel.
 *
 * Device example for the `programmable_pulse_generator` behavioral kind.
 * One coax rf_out emitting the bound TimingProgram's gate (the RF-Link
 * panel renders it as the "rfout" gate domain regardless of role domain).
 * BNC variants differ only by `connectorType`.
 *
 * The jack points +Z, matching the locked `ppg` Asset3D row (synced
 * 2026-08-17). It previously declared +X, which is 90° off — the same
 * connector-direction defect the AD9959 template had, and the one that
 * makes a mated cable render across the box instead of out of it.
 * `positionMmBodyLocal` is still deliberately absent: the asset carries
 * (0, 0, 4.8) but this is a generic device, so a seed at the origin plus
 * a manual drag stays the intended flow.
 */
export const ppg_sma = defineDevice({
  id: "ppg_sma",
  displayName: "PPG (SMA, TTL/Trigger out)",
  behavioralKind: "programmable_pulse_generator",
  componentType: "programmable_pulse_generator",
  mesh: "primitive://programmable_pulse_generator",
  anchors: [
    { role: "rf_out", connectorType: "sma_female", directionBodyLocal: { x: 0, y: 0, z: 1 } },
  ],
});
