import { defineDevice } from "./_device";

/**
 * CP33/M — Thorlabs cage plate, from the live `cp33_m_step` asset.
 *
 * Render-only fixture: `behavioralKind: null` (the LeafDevice contract's
 * "pure mechanical / no solver participation"), so attaching it leaves the
 * asset's `kind_id` at `mechanical` — the write-through only fires for a
 * non-null behavioral kind. No anchors and no params, matching the live
 * asset, so the attach is lossless.
 */
export const cp33_m = defineDevice({
  id: "cp33_m",
  displayName: "CP33/M",
  behavioralKind: null,
  componentType: "mechanical",
  mesh: "cp33_m_step.glb",
  anchors: [],
});
