import type { ElementKind } from "../types/digitalTwin";

const C = 299_792_458;

function nmToThz(nm: number): number {
  return C / (nm * 1e-9) / 1e12;
}

// Mirror of backend `OPTICAL_COMPONENT_TYPE_TO_KIND` from
// app/routers/components.py — keep in sync.
const COMPONENT_TYPE_TO_KIND: Record<string, ElementKind> = {
  laser: "laser_source",
  laser_source: "laser_source",
  tapered_amplifier: "tapered_amplifier",
  mirror: "mirror",
  // V2 Phase 5 (alembic 0031): catalog "lens" maps to lens_biconvex.
  lens: "lens_biconvex",
  lens_spherical: "lens_biconvex",
  lens_biconvex: "lens_biconvex",
  lens_plano_convex: "lens_plano_convex",
  lens_cylindrical: "lens_cylindrical",
  waveplate: "waveplate",
  polarizer: "polarizer",
  beam_splitter: "beam_splitter",
  dichroic_mirror: "dichroic_mirror",
  fiber_coupler: "fiber_coupler",
  fiber: "fiber",
  isolator: "isolator",
  aom: "aom",
  eom: "eom",
  nonlinear_crystal: "nonlinear_crystal",
  saturable_absorber: "saturable_absorber",
  detector: "detector",
  camera: "camera",
  spectrometer: "spectrometer",
  wavemeter: "wavemeter",
  beam_dump: "beam_dump",
};

export function componentTypeToOpticalKind(
  componentType: string | null | undefined,
): ElementKind | null {
  if (!componentType) return null;
  return COMPONENT_TYPE_TO_KIND[componentType.trim()] ?? null;
}

export const KIND_LABELS: Record<ElementKind, string> = {
  laser_source: "Laser Source",
  tapered_amplifier: "Tapered Amplifier",
  mirror: "Mirror",
  lens_biconvex: "Biconvex Lens",
  lens_plano_convex: "Plano-Convex Lens",
  lens_cylindrical: "Cylindrical Lens",
  waveplate: "Waveplate",
  polarizer: "Polarizer",
  beam_splitter: "Beam Splitter",
  dichroic_mirror: "Dichroic Mirror",
  fiber_coupler: "Fiber Coupler",
  fiber: "Fiber Patch Cable",
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
  rf_source: "RF Source",
};

export const KIND_GROUPS: { label: string; kinds: ElementKind[] }[] = [
  { label: "Emitters", kinds: ["laser_source", "tapered_amplifier"] },
  {
    label: "Passive",
    kinds: [
      "mirror",
      "lens_biconvex",
      "lens_plano_convex",
      "lens_cylindrical",
      "waveplate",
      "polarizer",
      "beam_splitter",
      "dichroic_mirror",
      "fiber_coupler",
      "fiber",
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
  {
    label: "RF",
    kinds: ["rf_source"],
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
  // V2 Phase 2: surface normal lives on
  // objects.properties.anchorBindings[opticalSurface].payload, not here.
  mirror: { reflectivity: 0.99 },
  lens_biconvex: { focalMm: 100.0, transmission: 0.99 },
  lens_plano_convex: { focalMm: 100.0, transmission: 0.99 },
  lens_cylindrical: { focalMm: 100.0, cylindricalAxis: "x", transmission: 0.99 },
  waveplate: { retardanceLambda: 0.5, fastAxisDegBeamLocal: 0.0, transmission: 0.99 },
  polarizer: { transmissionAxisDegBeamLocal: 0.0, extinctionRatioDb: 30.0, transmission: 0.95 },
  beam_splitter: {
    splitRatioTransmitted: 0.5,
    polarizing: false,
    transmissionAxisDegBeamLocal: 0.0,
    extinctionRatioDb: 30.0,
    transmission: 0.99,
    // Internal 45° coating normal in the SceneObject's local frame. The
    // geometric ray-tracer reflects off THIS normal — NOT the mesh's outer-
    // face normal — because the outer face has a normal along the beam
    // direction (which would back-reflect the beam, breaking the chain).
    // Default `(1, 1, 0)/√2` reflects a +X incoming beam to +Y (and a -X
    // beam to +Y as well — both upper-quadrant). Matches the orientation of
    // the Thorlabs PBS252 STL in our scene.
    coatingNormalBodyLocal: [0.7071067811865475, 0.7071067811865475, 0],
  },
  dichroic_mirror: {
    cutoffWavelengthNm: 700.0,
    passBand: "long",
    transmission: 0.95,
    reflectivity: 0.95,
  },
  fiber_coupler: { couplingEfficiency: 0.7, modeFieldDiameterUm: 5.0, fiberType: "single_mode" },
  // Defaults match a Thorlabs P1-780PM-FC-1 patch cable (PM single-mode,
  // 780 nm design, FC/PC connectors). Mirrors backend
  // routers/components.py DEFAULT_KIND_PARAMS["fiber"] so a freshly
  // created fiber element rehydrates identically through either path.
  fiber: {
    fiberType: "polarization_maintaining",
    endA: {
      apertureDiameterMm: 0.125,
      numericalAperture: 0.13,
      modeFieldDiameterUm: 5.3,
      coreDiameterUm: 4.4,
      claddingDiameterUm: 125.0,
      connectorType: "FC",
      polish: "PC",
      polishAngleDeg: 0.0,
      fresnelResidual: 1.0,
      glassIndexAtDesignLambda: 1.4506,
      slowAxisDegInBodyFrame: 0.0,
    },
    endB: {
      apertureDiameterMm: 0.125,
      numericalAperture: 0.13,
      modeFieldDiameterUm: 5.3,
      coreDiameterUm: 4.4,
      claddingDiameterUm: 125.0,
      connectorType: "FC",
      polish: "PC",
      polishAngleDeg: 0.0,
      fresnelResidual: 1.0,
      glassIndexAtDesignLambda: 1.4506,
      slowAxisDegInBodyFrame: 0.0,
    },
    cutoffWavelengthNm: 730.0,
    operatingWavelengthRangeNm: [770.0, 790.0],
    designWavelengthNm: 780.0,
    maxInputPowerMw: 500.0,
    attenuationCurve: [{ wavelengthNm: 780.0, dbPerKm: 5.0 }],
    bendLoss: {
      vNumber: 2.0,
      coreRadiusUm: 2.2,
      nCore: 1.4506,
      nClad: 1.4500,
      criticalRadiusMm: 25.0,
    },
    minBendRadiusMm: 25.0,
    birefringenceDeltaN: 5.0e-4,
    pmdCoefficientPsPerSqrtKm: 0.05,
    polarizationExtinctionRatioDb: 25.0,
    bandwidthMhzKm: null,
    randomJonesSeed: null,
  },
  isolator: { forwardLossDb: 0.5, isolationDb: 40.0, faradayRotationDeg: 45.0, transmissionAxisDegBeamLocal: 0.0 },
  aom: {
    baseEfficiency: 0.85,
    deflectionPerMhzUrad: 200.0,
    acousticVelocityMPerS: 4200.0,
    modulationBandwidthMhz: 20.0,
    centerFreqMhz: 80.0,
    refractiveIndex: 2.26,
    figureOfMeritM2: 34e-15,
    crystalLengthMm: 25.0,
    acousticBeamWidthMm: 1.5,
    rfDrivePowerW: 1.0,
    rfPowerMaxW: 2.0,
    acousticAxisBodyLocal: [-1, 0, 0],
    rfPropagationDirectionBodyLocal: [-1, 0, 0],
    diffractionOrder: 1,
    braggAngularAcceptanceMrad: 2.0,
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
  rf_source: {
    frequencyMhz: 80.0,
    powerDbm: 0.0,
    phaseDeg: 0.0,
    modulation: "none",
  },
};
