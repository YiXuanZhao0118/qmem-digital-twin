import { definePhysicsPlugin } from "../_plugin";
import { rfAmplifierTransfer } from "./transfer";

export interface RfAmplifierParams extends Record<string, unknown> {
  gainDb: number;
  frequencyRangeMhz: [number, number];
  outputPowerP1dbDbm: number;
  outputPowerMaxDbm: number;
  inputPowerMaxDbm: number;
  noiseFigureDb: number;
  supplyVoltageV: number;
  supplyCurrentA: number;
  inputReturnLossDb: number;
  outputReturnLossDb: number;
  connectorType: string;
}

export const rfAmplifierPlugin = definePhysicsPlugin<RfAmplifierParams>({
  id: "rf_amplifier",
  displayName: "RF Amplifier",
  componentTypes: ["rf_amplifier"],
  assetCategory: "electronics",
  catalogGroup: "RF",
  physics: {
    elementKind: "rf_amplifier",
    primaryDomain: "rf",
    defaultPhysics: ["rf", "thermal"],
    anchors: {
      required: ["rf_in", "rf_out"],
      optional: [],
      needsDirection: ["rf_in", "rf_out"],
    },
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary:
      "Coaxial RF amplifier (e.g. Mini-Circuits ZHL-1-2W+, ZHL-42W+). rf_in marks the input SMA / coax connector; rf_out marks the output SMA / coax connector. Both directions are OUTWARD face normals (pointing away from the body the way a mating plug slides on). Gain, frequency range, P_1dB, NF, and supply spec live in kindParams. Not aligned optically — RF signal flows through cables, not free space.",
    defaultParams: {
      gainDb: 29.0,
      frequencyRangeMhz: [5.0, 500.0],
      outputPowerP1dbDbm: 29.0,
      outputPowerMaxDbm: 30.0,
      inputPowerMaxDbm: 0.0,
      noiseFigureDb: 9.0,
      supplyVoltageV: 24.0,
      supplyCurrentA: 0.6,
      inputReturnLossDb: 14.0,
      outputReturnLossDb: 14.0,
      connectorType: "sma",
    },
    // Phase 3d: a coaxial amplifier is pure spec sheet — every parameter
    // is fixed by the part number. ZHL-1-2W+ doesn't have any user knob;
    // it just amplifies whatever Vpp / freq lands on its rf_in. The
    // Object panel renders this whole block read-only; "Operating" tab
    // stays empty. Gain calibration tweaks (a specific unit measuring
    // +28.7 dB instead of the spec +29) are an instance-level override —
    // they'd land in `SceneObject.properties.intrinsicOverrides.gainDb`,
    // not by mutating the catalog.
    intrinsicParamKeys: [
      "gainDb",
      "frequencyRangeMhz",
      "outputPowerP1dbDbm",
      "outputPowerMaxDbm",
      "inputPowerMaxDbm",
      "noiseFigureDb",
      "supplyVoltageV",
      "supplyCurrentA",
      "inputReturnLossDb",
      "outputReturnLossDb",
      "connectorType",
    ],
    stateParamKeys: [],
    portDomains: { rf_in: "rf", rf_out: "rf" },
    // Phase 5: the canonical example of the plugin-level transfer
    // pattern. The RF propagation walker (`utils/rfPropagation.ts`)
    // calls this whenever a signal arrives at rf_in. Adding a new RF
    // passthrough kind (attenuator, filter, …) is a one-file change:
    // write the plugin, declare `rfTransfer`, done. Backend parity
    // lives in `backend/app/solvers/rf_propagation.py`.
    rfTransfer: rfAmplifierTransfer,
  },
});
