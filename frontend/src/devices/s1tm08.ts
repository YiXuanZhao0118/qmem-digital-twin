import { defineDevice } from "./_device";

/**
 * S1TM08 — Thorlabs SM1 threaded adapter, from the live `s1tm08_step` asset.
 *
 * Render-only fixture — see `cp33_m` for the `behavioralKind: null` contract.
 */
export const s1tm08 = defineDevice({
  id: "s1tm08",
  displayName: "S1TM08",
  behavioralKind: null,
  componentType: "mechanical",
  mesh: "s1tm08_step.glb",
  anchors: [],
});
