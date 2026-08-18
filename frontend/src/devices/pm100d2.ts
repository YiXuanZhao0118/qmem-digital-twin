import { defineDevice } from "./_device";

/**
 * PM100D2 — Thorlabs power-meter console, from the live `pm100d2_step` asset.
 *
 * `behavioralKind: null` is a PLACEHOLDER, not a claim: the asset's kind is
 * still `unclassified` and it carries no anchors, so it cannot be traced
 * either way. A null behavioral kind leaves `kind_id` untouched on attach
 * (the write-through only fires for a non-null one), which keeps this device
 * from silently promoting the row. Promote it to `detector` — with a real
 * sensor-face anchor — when the head is modelled.
 */
export const pm100d2 = defineDevice({
  id: "pm100d2",
  displayName: "PM100D2",
  behavioralKind: null,
  componentType: "mechanical",
  mesh: "pm100d2_step.glb",
  anchors: [],
});
