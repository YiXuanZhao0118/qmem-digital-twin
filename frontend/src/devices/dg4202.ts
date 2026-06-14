import { defineDevice } from "./_device";

/**
 * Rigol DG4202 — 2-channel arbitrary-waveform / function generator.
 *
 * The plan's "add the 50th instrument = add one file" proof (§5 step 4): a
 * second `rf_source` device alongside the AD9959, differing only in channel
 * count (2 vs 4) and mesh. Zero behavioral-kind / dispatch / py / test changes
 * — the RF BFS seeds one signal per `rf_out` anchor regardless of count.
 *
 * Maps to the `rf_generator` componentType (the generic signal-generator form
 * of rf_source, vs the AD9959's `dds_ad9959_pcb`). Anchors seed at origin and
 * are dragged onto the front-panel BNC outputs in the PHY Editor; both are
 * outward face normals. (Coordinates are cosmetic for the RF graph — only
 * role + name matter to the BFS.)
 */
export const dg4202 = defineDevice({
  id: "dg4202",
  displayName: "Rigol DG4202 (2-ch AWG)",
  behavioralKind: "rf_source",
  componentType: "rf_generator",
  mesh: "primitive://rf_source",
  anchors: [
    { role: "rf_out", name: "CH1", connectorType: "bnc_female", directionBodyLocal: { x: 1, y: 0, z: 0 } },
    { role: "rf_out", name: "CH2", connectorType: "bnc_female", directionBodyLocal: { x: 1, y: 0, z: 0 } },
  ],
  defaultParams: {
    maxOutputMHz: 200,
  },
});
