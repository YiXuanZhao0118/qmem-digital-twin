import type { ElementKind } from "../types/digitalTwin";

const C = 299_792_458;

function nmToThz(nm: number): number {
  return C / (nm * 1e-9) / 1e12;
}

export const KIND_LABELS: Record<ElementKind, string> = {
  laser_source: "Laser Source",
  tapered_amplifier: "Tapered Amplifier",
  mirror: "Mirror",
  lens_spherical: "Spherical Lens",
  lens_cylindrical: "Cylindrical Lens",
  waveplate: "Waveplate",
  polarizer: "Polarizer",
  beam_splitter: "Beam Splitter",
  dichroic_mirror: "Dichroic Mirror",
  fiber_coupler: "Fiber Coupler",
  isolator: "Isolator",
  aom: "AOM",
  eom: "EOM",
  nonlinear_crystal: "Nonlinear Crystal",
  saturable_absorber: "Saturable Absorber",
  detector: "Detector",
  camera: "Camera",
  spectrometer: "Spectrometer",
  wavemeter: "Wavemeter",
  beam_dump: "Beam Dump",
};

export const KIND_GROUPS: { label: string; kinds: ElementKind[] }[] = [
  { label: "Emitters", kinds: ["laser_source", "tapered_amplifier"] },
  {
    label: "Passive",
    kinds: [
      "mirror",
      "lens_spherical",
      "lens_cylindrical",
      "waveplate",
      "polarizer",
      "beam_splitter",
      "dichroic_mirror",
      "fiber_coupler",
      "isolator",
    ],
  },
  {
    label: "Active / Nonlinear",
    kinds: ["aom", "eom", "nonlinear_crystal", "saturable_absorber"],
  },
  {
    label: "Sinks",
    kinds: ["detector", "camera", "spectrometer", "wavemeter", "beam_dump"],
  },
];

export const DEFAULT_KIND_PARAMS: Record<ElementKind, Record<string, unknown>> = {
  laser_source: {
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
  tapered_amplifier: {
    smallSignalGainDb: 30.0,
    saturationPowerMw: 500.0,
    maxInputPowerMw: 30.0,
    ase: { powerMw: 5.0, bandwidthNm: 1.0, centerOffsetNm: 0.0 },
    outputSpatialModeX: { waistUm: 500, waistZOffsetMm: 0, mSquared: 1.5 },
    outputSpatialModeY: { waistUm: 50, waistZOffsetMm: 0, mSquared: 8.0 },
    outputTransverseMode: { kind: "TEM00" },
  },
  mirror: { reflectivity: 0.99, normalLocal: [1, 0, 0] },
  lens_spherical: { focalMm: 100.0, transmission: 0.99 },
  lens_cylindrical: { focalMm: 100.0, cylindricalAxis: "x", transmission: 0.99 },
  waveplate: { retardanceLambda: 0.5, fastAxisDeg: 0.0, transmission: 0.99 },
  polarizer: { transmissionAxisDeg: 0.0, extinctionRatioDb: 30.0, transmission: 0.95 },
  beam_splitter: { splitRatioTransmitted: 0.5, polarizing: false, transmission: 0.99 },
  dichroic_mirror: {
    cutoffWavelengthNm: 700.0,
    passBand: "long",
    transmission: 0.95,
    reflectivity: 0.95,
  },
  fiber_coupler: { couplingEfficiency: 0.7, modeFieldDiameterUm: 5.0, fiberType: "single_mode" },
  isolator: { forwardLossDb: 0.5, isolationDb: 40.0, transmissionAxisDeg: 0.0 },
  aom: {
    baseEfficiency: 0.85,
    deflectionPerMhzUrad: 200.0,
    acousticVelocityMPerS: 4200.0,
    modulationBandwidthMhz: 20.0,
    centerFreqMhz: 80.0,
  },
  eom: {
    vPiV: 5.0,
    modulationKind: "phase",
    modulationBandwidthMhz: 100.0,
    insertionLossDb: 3.0,
  },
  nonlinear_crystal: {
    process: "SHG",
    chi2PmPerV: 4.5,
    lengthMm: 10.0,
    walkOffUrad: 0.0,
  },
  saturable_absorber: {
    saturationIntensityWPerCm2: 1e6,
    modulationDepth: 0.5,
    nonSaturableLoss: 0.05,
    recoveryTimePs: 1.0,
  },
  detector: {
    responsivityAPerW: 0.5,
    quantumEfficiency: 0.8,
    bandwidthMhz: 1000.0,
    saturationPowerMw: 10.0,
  },
  camera: {
    resolutionPx: [1024, 1024],
    pixelSizeUm: 5.5,
    quantumEfficiency: 0.5,
    wellDepthE: 20000,
  },
  spectrometer: { resolutionPm: 10.0, wavelengthRangeNm: [400, 1100] },
  wavemeter: { precisionMhz: 1.0 },
  beam_dump: { absorption: 0.999 },
};
