import { definePhysicsPlugin } from "../_plugin";

const C_M_PER_S = 299_792_458;

function nmToThz(nm: number): number {
  return C_M_PER_S / (nm * 1e-9) / 1e12;
}

interface SpectrumComponent {
  kind: string;
  lineshape: string;
  offsetMhz: number;
  fwhmMhz: number;
  amplitude: number;
}

interface Spectrum {
  centerThz: number;
  components: SpectrumComponent[];
}

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

export interface LaserSourceParams extends Record<string, unknown> {
  centerWavelengthNm: number;
  spectrum: Spectrum;
  spatialModeX: GaussianMode;
  spatialModeY: GaussianMode;
  // Legacy decorative label — optional, no longer in the kind default
  // (superseded by transverseModeType below). Readers fall back to TEM00.
  transverseMode?: { kind: string };
  // Transverse-mode control (decoupled from the decorative `transverseMode`
  // label). The emitter folds these into the per-axis beam-width multiplier
  // (LG: √(2p+|l|+1) both axes; HG: x=√(2m+1), y=√(2n+1)). 0/0 = TEM00.
  transverseModeType: "HG" | "LG";
  mode_index_1: number; // HG m (X order) / LG p (radial)
  mode_index_2: number; // HG n (Y order) / LG l (azimuthal topological charge)
  polarization: JonesVector;
  nominalPowerMw: number;
}

export const laserSourcePlugin = definePhysicsPlugin<LaserSourceParams>({
  id: "laser_source",
  displayName: "Laser Source",
  componentTypes: ["laser_source", "laser"],
  assetCategory: "optical",
  catalogGroup: "Emitters",
  physics: {
    elementKind: "laser_source",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "thermal"],
    anchors: {
      required: [],
      optional: ["out", "intercept_out"],
      needsDirection: [],
      // The emit anchor's axisY is the linear-polarization reference for
      // the emitted beam (the Jones vector in defaultParams.polarization
      // is defined in this axisY/axisZ basis). Editable in the PHY Editor.
      needsFastAxis: ["out", "intercept_out"],
    },
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary: "Emitter — beam originates here. Not aligned to anything.",
    defaultParams: {
      centerWavelengthNm: 852.347,
      spectrum: {
        centerThz: nmToThz(852.347),
        components: [
          { kind: "main", lineshape: "lorentzian", offsetMhz: 0, fwhmMhz: 0.1, amplitude: 1.0 },
        ],
      },
      spatialModeX: { waistUm: 2.2, waistZOffsetMm: 0.0, mSquared: 1.15 },
      spatialModeY: { waistUm: 0.52, waistZOffsetMm: 0.006, mSquared: 1.08 },
      transverseModeType: "HG",
      mode_index_1: 0,
      mode_index_2: 0,
      polarization: { exRe: 1.0, exIm: 0.0, eyRe: 0.0, eyIm: 0.0 },
      nominalPowerMw: 50.0,
    },
  },
});
