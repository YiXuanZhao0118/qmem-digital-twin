import { definePhysicsPlugin } from "../_plugin";

interface GaussianMode {
  waistUm: number;
  waistZOffsetMm: number;
  mSquared: number;
}

interface JonesVector {
  exRe: number;
  exIm: number;
  eyRe: number;
  eyIm: number;
}

export interface TaperedAmplifierParams extends Record<string, unknown> {
  smallSignalGainDb: number;
  saturationPowerMw: number;
  minInputPowerMw: number;
  maxInputPowerMw: number;
  inputAcceptanceRadiusMm: number;
  ase: { powerMw: number; bandwidthNm: number; centerOffsetNm: number };
  inputSpatialModeX: GaussianMode;
  inputSpatialModeY: GaussianMode;
  inputPolarization: JonesVector;
  outputSpatialModeX: GaussianMode;
  outputSpatialModeY: GaussianMode;
  outputTransverseMode: { kind: string };
}

export const taperedAmplifierPlugin = definePhysicsPlugin<TaperedAmplifierParams>({
  id: "tapered_amplifier",
  displayName: "Tapered Amplifier",
  componentTypes: ["tapered_amplifier"],
  assetCategory: "optical",
  catalogGroup: "Emitters",
  physics: {
    elementKind: "tapered_amplifier",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "thermal"],
    anchors: {
      required: ["intercept_in", "intercept_out"],
      optional: ["seed"],
      needsDirection: ["intercept_in", "intercept_out"],
    },
    alignVariant: "translate_anti_parallel",
    alignToleranceMm: 25,
    alignSummary:
      "Dual-anchor kind: intercept_in marks INPUT face (where seed light enters) and intercept_out marks OUTPUT face (where amplified beam exits). Both directions are OUTWARD face normals (point away from chip body). The two faces don't have to be opposite — side-output / shaped TAs route the amplified beam at any angle. The chip's mode profile + polarization preferences live in kindParams (not in the anchor).",
    defaultParams: {
      smallSignalGainDb: 30.0,
      saturationPowerMw: 500.0,
      minInputPowerMw: 10.0,
      maxInputPowerMw: 30.0,
      inputAcceptanceRadiusMm: 25.0,
      ase: { powerMw: 5.0, bandwidthNm: 1.0, centerOffsetNm: 0.0 },
      inputSpatialModeX: { waistUm: 600, waistZOffsetMm: 0, mSquared: 1.5 },
      inputSpatialModeY: { waistUm: 600, waistZOffsetMm: 0, mSquared: 1.5 },
      inputPolarization: { exRe: 0, exIm: 0, eyRe: 1, eyIm: 0 },
      outputSpatialModeX: { waistUm: 500, waistZOffsetMm: 0, mSquared: 1.5 },
      outputSpatialModeY: { waistUm: 50, waistZOffsetMm: 0, mSquared: 8.0 },
      outputTransverseMode: { kind: "TEM00" },
    },
  },
});
