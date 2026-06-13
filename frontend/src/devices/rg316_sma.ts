import { defineDevice } from "./_device";

/**
 * RG-316 SMA jumper — coaxial RF cable.
 *
 * Device example for the `rf_cable` behavioral kind. Two SMA tips
 * (rf_in = End A, rf_out = End B); the cable is a transparent graph edge in
 * the RF BFS (zero loss). Length seeds from the kind default (152 mm).
 * Spline editing is a follow-up; anchors seed at origin as outward normals.
 */
export const rg316_sma = defineDevice({
  id: "rg316_sma",
  displayName: "RG-316 SMA jumper (RF cable)",
  behavioralKind: "rf_cable",
  componentType: "rf_cable",
  mesh: "primitive://rf_cable",
  anchors: [
    { role: "rf_in", connectorType: "sma_male" },
    { role: "rf_out", connectorType: "sma_male" },
  ],
});
