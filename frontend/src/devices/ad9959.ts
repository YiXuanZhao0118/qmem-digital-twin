import { defineDevice } from "./_device";

/**
 * Analog Devices AD9959/PCBZ — 4-channel DDS evaluation board.
 *
 * Validation device for the device-registry refactor (plan §5/§6). Four
 * SMA outputs (CH0..CH3) on the +X edge of the 165.1 × 114.3 × 19.3 mm
 * mesh (body centred at origin, Z-up). z = 4 mm sits on top of the
 * 9.65 mm-half-thickness PCB. Coordinates are the measured values lifted
 * verbatim from the retired `rf_source.componentAnchorContracts` entry —
 * the device registry is now their single home.
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
      positionMmBodyLocal: { x: 82.55, y: -30.0, z: 4.0 },
      directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
      connectorType: "sma_female",
    },
    {
      role: "rf_out",
      name: "CH1",
      positionMmBodyLocal: { x: 82.55, y: -10.0, z: 4.0 },
      directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
      connectorType: "sma_female",
    },
    {
      role: "rf_out",
      name: "CH2",
      positionMmBodyLocal: { x: 82.55, y: 10.0, z: 4.0 },
      directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
      connectorType: "sma_female",
    },
    {
      role: "rf_out",
      name: "CH3",
      positionMmBodyLocal: { x: 82.55, y: 30.0, z: 4.0 },
      directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
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
