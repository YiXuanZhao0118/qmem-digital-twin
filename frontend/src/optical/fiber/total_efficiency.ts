/**
 * End-to-end fiber transmission efficiency. Combines:
 *   - Mode-overlap coupling at the input face (η_coupling)
 *   - Fresnel reflectance at both faces (η_fresnel_A, η_fresnel_B)
 *   - Wavelength-dependent attenuation along the spline (η_attenuation)
 *   - Marcuse curvature loss along the spline (η_bend)
 *
 * Polarization is handled separately (state-tracking, not power loss).
 *
 *   η_total = η_coupling · η_fresnel_A · η_attenuation · η_bend · η_fresnel_B
 */

import type {
  FiberAttenuationPoint,
  BendLossConstants,
  FiberType,
} from "../../types/digitalTwin";
import {
  computeCouplingEfficiency,
  type BeamInputAtFace,
  type FiberFaceSpec,
  type CouplingBreakdown,
} from "./coupling";
import { fresnelReflectance } from "./fresnel";
import { attenuationTransmittance } from "./attenuation";
import { bendLossTransmittance } from "./bend_loss";

export type FaceFresnelInputs = {
  /** Angle of incidence at this face (rad). */
  thetaIRad: number;
  /** Polarization angle relative to plane of incidence (rad). */
  chiRad: number;
  /** Glass refractive index at design wavelength. */
  glassIndex: number;
  /** AR-coating residual factor. */
  arResidual: number;
};

export type FiberTotalEfficiencyInputs = {
  fiberType: FiberType;
  beamInput: BeamInputAtFace;
  inputFace: FiberFaceSpec;
  outputFace: FiberFaceSpec;
  inputFresnel: FaceFresnelInputs;
  /** For the exit face: angle of incidence inside fiber going to air. */
  outputFresnel: FaceFresnelInputs;
  attenuationCurve: FiberAttenuationPoint[];
  lambdaNm: number;
  arcLengthMm: number;
  bendLoss: BendLossConstants;
  /** Closure that returns curvature radius at parametric t ∈ [0, 1]
   *  along the spline (mm). For bend-loss integration. */
  curvatureRadiusAt: (t: number) => number;
};

export type FiberTotalEfficiencyResult = {
  etaTotal: number;
  etaCoupling: number;
  etaFresnelA: number;
  etaFresnelB: number;
  etaAttenuation: number;
  etaBend: number;
  couplingBreakdown: CouplingBreakdown;
};

export function computeFiberTotalEfficiency(
  args: FiberTotalEfficiencyInputs,
): FiberTotalEfficiencyResult {
  const couplingBreakdown = computeCouplingEfficiency(
    args.beamInput,
    args.inputFace,
  );
  const etaCoupling = couplingBreakdown.etaCoupling;

  // Fresnel: input air → glass; output glass → air
  const fresnelInRes = fresnelReflectance({
    thetaIRad: args.inputFresnel.thetaIRad,
    n1: 1.0,
    n2: args.inputFresnel.glassIndex,
    chiRad: args.inputFresnel.chiRad,
    arResidual: args.inputFresnel.arResidual,
  });
  const etaFresnelA = fresnelInRes.transmittance;

  const fresnelOutRes = fresnelReflectance({
    thetaIRad: args.outputFresnel.thetaIRad,
    n1: args.outputFresnel.glassIndex,
    n2: 1.0,
    chiRad: args.outputFresnel.chiRad,
    arResidual: args.outputFresnel.arResidual,
  });
  const etaFresnelB = fresnelOutRes.transmittance;

  const etaAttenuation = attenuationTransmittance(
    args.attenuationCurve,
    args.lambdaNm,
    args.arcLengthMm,
  );
  const etaBend = bendLossTransmittance(
    args.curvatureRadiusAt,
    args.arcLengthMm,
    args.bendLoss,
  );

  const etaTotal = etaCoupling * etaFresnelA * etaAttenuation * etaBend * etaFresnelB;

  return {
    etaTotal,
    etaCoupling,
    etaFresnelA,
    etaFresnelB,
    etaAttenuation,
    etaBend,
    couplingBreakdown,
  };
}
