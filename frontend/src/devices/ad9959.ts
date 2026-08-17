import { defineDevice } from "./_device";

/**
 * Analog Devices AD9959/PCBZ — 4-channel DDS evaluation board.
 *
 * Validation device for the device-registry refactor (plan §5/§6). Four
 * SMA jacks (CH0..CH3) mounted on the FACE of the 165.1 × 114.3 × 19.3 mm
 * PCB (body centred at origin, Z-up), pointing +Z — not along the +X edge.
 * Their footprint is irregular, not an evenly-spaced row.
 *
 * Coordinates below are the measured values, synced 2026-08-17 from the
 * `ad9959` Asset3D row, which is locked (human-confirmed complete). They
 * previously carried a nominal placeholder layout inherited from the
 * retired `rf_source.componentAnchorContracts` entry — x = 82.55 for all
 * four channels, y evenly spaced −30/−10/+10/+30, z = 4, direction +X —
 * which put every channel ~60 mm from where it really is and pointed the
 * connectors 90° off. The asset was authored correctly and the template
 * was never updated to match, so this file, not the asset, was the stale
 * one. See docs/float64-audit.md §3-5.
 *
 * REF_IN / SYS_IN / SYS_OUT are deliberately absent: the system clock
 * fans in from the chassis TCXO module and sync chaining is a chassis-level
 * concern, not per-AD9959 anchors.
 *
 * Adding a sibling DDS (e.g. DG4202) is a new file like this one with a
 * different channel count — zero behavioral-kind / dispatch / test changes.
 */
export const ad9959 = defineDevice({
  id: "ad9959",
  displayName: "Analog Devices AD9959/PCBZ (4-ch DDS)",
  behavioralKind: "rf_source",
  componentType: "dds_ad9959_pcb",
  mesh: "ad9959_pcbz_lod1.stl",
  anchors: [
    {
      role: "rf_out",
      name: "CH0",
      positionMmBodyLocal: { x: 55.1, y: 21.7, z: 2.0 },
      directionBodyLocal: { x: 0.0, y: 0.0, z: 1.0 },
      connectorType: "sma_female",
    },
    {
      role: "rf_out",
      name: "CH1",
      positionMmBodyLocal: { x: 33.3, y: 27.8, z: 2.0 },
      directionBodyLocal: { x: 0.0, y: 0.0, z: 1.0 },
      connectorType: "sma_female",
    },
    {
      role: "rf_out",
      name: "CH2",
      positionMmBodyLocal: { x: 34.5, y: -31.0, z: 2.0 },
      directionBodyLocal: { x: 0.0, y: 0.0, z: 1.0 },
      connectorType: "sma_female",
    },
    {
      role: "rf_out",
      name: "CH3",
      positionMmBodyLocal: { x: 55.058, y: -24.7, z: 2.0 },
      directionBodyLocal: { x: 0.0, y: 0.0, z: 1.0 },
      connectorType: "sma_female",
    },
  ],
  defaultParams: {
    // Full-scale single-ended Vpp into 50 Ω at default Rset. The RF trace
    // reads this asset coefficient (per-channel amplitudeScale × fullScaleVpp);
    // seeded onto the asset's default_params so a device re-seed carries it.
    fullScaleVpp: 1.0,
    maxOutputMHz: 200,
    refClockMHz: 20,
  },
});
