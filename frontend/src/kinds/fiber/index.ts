/**
 * Fiber Patch Cable — bidirectional optical patch cable, rendered
 * procedurally from a Bezier spline (no static GLB/STL asset).
 *
 * Storage: anchors live on Component.properties.fiberAnchors[] (parallel
 * to Asset.anchors[]) because fiber has no Asset3D — each patch cable
 * is its own 1:1 Component template.
 *
 * End A = first spline node; End B = last. Both ends carry an FC
 * connector whose ferrule points outward along the Bezier handle. The
 * intercept_in anchor rides End A's connector frame; intercept_out
 * rides End B's. Moving a spline node carries the optical port with it.
 */
import { definePhysicsPlugin } from "../_plugin";

export interface FiberEndSpec extends Record<string, unknown> {
  apertureDiameterMm: number;
  numericalAperture: number;
  modeFieldDiameterUm: number;
  coreDiameterUm: number;
  claddingDiameterUm: number;
  connectorType: "FC" | "SC" | "ST" | "LC";
  polish: "PC" | "APC" | "UPC";
  polishAngleDeg: number;
  fresnelResidual: number;
  glassIndexAtDesignLambda: number;
  slowAxisDegInBodyFrame: number;
}

export interface FiberParams extends Record<string, unknown> {
  fiberType: "single_mode" | "multi_mode" | "polarization_maintaining";
  endA: FiberEndSpec;
  endB: FiberEndSpec;
  cutoffWavelengthNm: number;
  operatingWavelengthRangeNm: [number, number];
  designWavelengthNm: number;
  maxInputPowerMw: number;
  attenuationCurve: Array<{ wavelengthNm: number; dbPerKm: number }>;
  bendLoss: {
    vNumber: number;
    coreRadiusUm: number;
    nCore: number;
    nClad: number;
    criticalRadiusMm: number;
  };
  minBendRadiusMm: number;
  birefringenceDeltaN: number;
  pmdCoefficientPsPerSqrtKm: number;
  polarizationExtinctionRatioDb: number;
  bandwidthMhzKm: number | null;
  randomJonesSeed: number | null;
}

const DEFAULT_END: FiberEndSpec = {
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
};

export const fiberPlugin = definePhysicsPlugin<FiberParams>({
  id: "fiber",
  displayName: "Fiber Patch Cable",
  componentTypes: ["fiber"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "fiber",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in", "intercept_out"],
      optional: [],
      needsDirection: ["intercept_in", "intercept_out"],
    },
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Bidirectional patch cable, rendered procedurally from a Bezier spline (no static GLB/STL asset). " +
      "End A = first spline node; End B = last. intercept_in rides End A's connector frame, intercept_out rides End B's — moving a spline node carries the optical port with it. " +
      "The two Align End A/B buttons snap the PORT onto the closest beam-path segment within alignToleranceMm (≤25 mm), then back-derive the spline node 36.28 mm BEHIND the projected port along the new outward direction. Interior nodes don't move.",
    defaultParams: {
      fiberType: "polarization_maintaining",
      endA: { ...DEFAULT_END },
      endB: { ...DEFAULT_END },
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
  },
});
