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
  transverseMode: { kind: string };
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
    },
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary: "Emitter — beam originates here. Not aligned to anything.",
    defaultParams: {
      centerWavelengthNm: 780.241,
      spectrum: {
        centerThz: nmToThz(780.241),
        components: [
          { kind: "main", lineshape: "lorentzian", offsetMhz: 0, fwhmMhz: 0.1, amplitude: 1.0 },
        ],
      },
      spatialModeX: { waistUm: 250, waistZOffsetMm: 0, mSquared: 1.05 },
      spatialModeY: { waistUm: 80, waistZOffsetMm: 1.2, mSquared: 1.30 },
      transverseMode: { kind: "TEM00" },
      polarization: { exRe: 1, exIm: 0, eyRe: 0, eyIm: 0 },
      nominalPowerMw: 50.0,
    },
  },
});
