import { defineDevice } from "./_device";

/**
 * KS1T — Thorlabs SM1-threaded Ø1" precision kinematic mirror mount
 * (identity per `backend/scripts/seed.py`), from the live `ks1t_step` asset.
 *
 * Render-only fixture — see `cp33_m` for the `behavioralKind: null` contract.
 */
export const ks1t = defineDevice({
  id: "ks1t",
  displayName: "KS1T",
  behavioralKind: null,
  componentType: "mechanical",
  mesh: "ks1t_step.glb",
  anchors: [],
});
