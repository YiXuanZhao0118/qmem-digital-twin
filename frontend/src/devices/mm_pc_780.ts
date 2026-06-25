import { defineDevice } from "./_device";

/**
 * Fiber Connector FC/PC (MM 50µm) — device template (auto-derived from the live `mm_pc_780` asset).
 *
 * behavioralKind `fiber_connector`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const mm_pc_780 = defineDevice({
  id: "mm_pc_780",
  displayName: "Fiber Connector FC/PC (MM 50µm)",
  behavioralKind: "fiber_connector",
  componentType: "fiber_connector",
  mesh: "thorlabs_fc_apc_30126a9.stl",
  anchors: [
    {
      role: "connect_out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: -1, y: 0, z: 0 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
    },
    {
      role: "connect_in",
      positionMmBodyLocal: { x: 36.28, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 0.125,
      apertureShape: "circle",
    },
  ],
  defaultParams: {
    na: 0.22,
    returnLossDb: 40,
    slowAxisKeyed: false,
    polishAngleDeg: 0,
  },
});
