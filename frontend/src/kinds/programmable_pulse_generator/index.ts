import { definePhysicsPlugin } from "../_plugin";

export interface ProgrammablePulseGeneratorParams extends Record<string, unknown> {
  connectorType: "sma" | "bnc";
  timingProgramId: string | null;
  outputDomain: "ttl" | "trigger";
  highVoltageV: number;
}

export const programmablePulseGeneratorPlugin =
  definePhysicsPlugin<ProgrammablePulseGeneratorParams>({
    id: "programmable_pulse_generator",
    displayName: "Programmable Pulse Generator",
    componentTypes: ["programmable_pulse_generator"],
    assetCategory: "electronics",
    catalogGroup: "RF",
    physics: {
      elementKind: "programmable_pulse_generator",
      primaryDomain: "rf",
      defaultPhysics: ["rf"],
      anchors: {
        required: [],
        optional: ["rf_out"],
        needsDirection: ["rf_out"],
      },
      alignVariant: "none",
      alignToleranceMm: 0,
      alignSummary:
        "Programmable Pulse Generator (PPG) is the physical one-to-one output for a Pulse & Timing TimingProgram. One coax rf_out anchor emits TTL or Trigger according to the bound program kind. SMA and BNC variants differ only by connector.",
      defaultParams: {
        connectorType: "sma",
        timingProgramId: null,
        outputDomain: "ttl",
        highVoltageV: 3.2,
      },
    },
  });
