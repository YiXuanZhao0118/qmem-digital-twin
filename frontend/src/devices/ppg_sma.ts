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
 * Position synced 2026-08-17 from the locked `ppg` Asset3D row. Its GLB
 * (542f66d2…_ppg.glb) is a 14.1 mm-diameter body running z −29.7 → 13.8,
 * with the jack protruding from roughly z 6 to 13.8 on the (x, y) = (0, 0)
 * axis; the axis matches to three decimals, so only the z landmark rests
 * on the asset author's judgement rather than on a feature this scan could
 * pin. Flagged in docs/float64-audit.md §3-5 as the least corroborated of
 * the three.
 */
export const ppg_sma = defineDevice({
  id: "ppg_sma",
  displayName: "PPG (SMA, TTL/Trigger out)",
  behavioralKind: "programmable_pulse_generator",
  componentType: "programmable_pulse_generator",
  mesh: "primitive://programmable_pulse_generator",
  anchors: [
    {
      role: "rf_out",
      positionMmBodyLocal: { x: 0, y: 0, z: 4.8 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
      connectorType: "sma_female",
    },
  ],
});
