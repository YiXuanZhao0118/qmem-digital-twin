import { defineDevice } from "./_device";

/**
 * RS1P — Thorlabs 1" pedestal post (25.0 mm, per the RS-series height table
 * in `backend/scripts/seed.py`), from the live `rs1p_step` asset.
 *
 * Render-only fixture — see `cp33_m` for the `behavioralKind: null` contract.
 */
export const rs1p = defineDevice({
  id: "rs1p",
  displayName: "RS1P",
  behavioralKind: null,
  componentType: "mechanical",
  mesh: "rs1p_step.glb",
  anchors: [],
});
