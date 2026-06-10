import { definePhysicsPlugin } from "../_plugin";

export interface RfSourceParams extends Record<string, unknown> {
  channels: unknown;
}

export const rfSourcePlugin = definePhysicsPlugin<RfSourceParams>({
  id: "rf_source",
  displayName: "RF Source",
  // dds_ad9959_pcb and rf_generator are physical-form aliases that map
  // to the same kind (DDS evaluation board vs generic signal generator).
  componentTypes: ["rf_source", "dds_ad9959_pcb", "rf_generator"],
  assetCategory: "electronics",
  catalogGroup: "RF",
  physics: {
    elementKind: "rf_source",
    primaryDomain: "rf",
    defaultPhysics: ["rf"],
    anchors: {
      required: [],
      optional: ["rf_out"],
      needsDirection: [],
    },
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary:
      "RF emitter — DDS / synth / arbitrary-waveform generator. Drives downstream RF chain (amp / filter / AOM-EOM driver). Not aligned optically.",
    defaultParams: {
      channels: null,
    },
    // Per-channel freq/amp seed the RF propagation walk; the legacy
    // single-tone fields + AD9959 PLL/clock straps were unused metadata.
    stateParamKeys: ["channels"],
    portDomains: { rf_out: "rf" },
  },
  // Per-component-type anchor templates (Stage H — single source of
  // truth, was previously duplicated in backend/app/components/
  // anchor_contracts.py + frontend/src/components/componentAnchor
  // Contracts.ts). The backend reads this same data via the kinds
  // manifest.
  componentAnchorContracts: {
    // Analog Devices AD9959/PCBZ — 4-channel DDS evaluation board.
    // 4 SMA outputs (CH0..CH3) on the +X edge of the 165.1 × 114.3 ×
    // 19.3 mm STL mesh (body centred at origin, Z-up). Z = 4 mm puts
    // the anchor on top of the 9.65-mm-half-thickness PCB; tweak in
    // PHY Editor to match the actual SMA centre once you eyeball it
    // against the mesh.
    //
    // REF_IN / SYS_IN / SYS_OUT removed 2026-05-13 — the system clock
    // fans in from ``dds_tcxo_fanout_module`` and sync chaining is
    // handled at the chassis level, not as per-AD9959 anchors.
    dds_ad9959_pcb: [
      {
        id: "rf_out",
        name: "CH0",
        positionMmBodyLocal: { x: 82.55, y: -30.0, z: 4.0 },
        directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
      },
      {
        id: "rf_out",
        name: "CH1",
        positionMmBodyLocal: { x: 82.55, y: -10.0, z: 4.0 },
        directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
      },
      {
        id: "rf_out",
        name: "CH2",
        positionMmBodyLocal: { x: 82.55, y: 10.0, z: 4.0 },
        directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
      },
      {
        id: "rf_out",
        name: "CH3",
        positionMmBodyLocal: { x: 82.55, y: 30.0, z: 4.0 },
        directionBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
      },
    ],
  },
});
