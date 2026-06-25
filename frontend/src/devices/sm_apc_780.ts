import { defineDevice } from "./_device";

/**
 * sm_780_apc — device template (auto-derived from the live `sm_apc_780` asset).
 *
 * behavioralKind `fiber_connector`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const sm_apc_780 = defineDevice({
  id: "sm_apc_780",
  displayName: "sm_780_apc",
  behavioralKind: "fiber_connector",
  componentType: "fiber_connector",
  mesh: "sm_apc_780.glb",
  anchors: [
    {
      role: "connect_out",
      positionMmBodyLocal: { x: 0.001, y: 0.001, z: 0 },
      directionBodyLocal: { x: 0, y: 0, z: -1 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 0,
      apertureShape: "circle",
    },
    {
      role: "connect_in",
      positionMmBodyLocal: { x: 0.001, y: -0.055, z: 56.815 },
      directionBodyLocal: { x: 0, y: -0.13904025798287284, z: 0.9902867295183028 },
      axisYBodyLocal: { x: 0, y: 0.9902867295183028, z: 0.13904025798287284 },
      apertureMm: 0.125,
      apertureShape: "circle",
    },
  ],
  defaultParams: {
    na: 0.13,
    mfdUm: 5,
    returnLossDb: 60,
    slowAxisKeyed: false,
    polishAngleDeg: 8,
  },
});
