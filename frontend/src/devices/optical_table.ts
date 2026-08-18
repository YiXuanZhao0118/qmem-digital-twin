import { defineDevice } from "./_device";

/**
 * Optical table — the scene's base fixture, from the live `optical_table`
 * asset (passive kind `optical_table`, no physics op).
 *
 * Render-only — see `cp33_m` for the `behavioralKind: null` contract. Its
 * `kind_id` therefore stays `optical_table` on attach.
 */
export const optical_table = defineDevice({
  id: "optical_table",
  displayName: "optical_table",
  behavioralKind: null,
  componentType: "optical_table",
  mesh: "optical_table.glb",
  anchors: [],
});
