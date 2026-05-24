/**
 * Dichroic Mirror PhysicsOps — wavelength-dependent transmit / reflect.
 *
 * Kind:  `dichroic_mirror`
 * Ops:
 *   - `dichroic_transmit`: ray continues through if λ falls in the
 *     transmit band; power *= T(λ). Direction unchanged.
 *   - `dichroic_reflect`:  ray reflects off face_in.normal if λ falls
 *     in the reflect band; power *= (1 − T(λ)).
 *
 * Asset declares TWO transitions on the same hit face — the tracer
 * fires both, and the wavelength split is determined by T(λ).
 *
 * T(λ) model (params, all optional):
 *   - cutoffWavelengthNm        — band edge
 *   - isShortPass: bool         — true (default): T=1 below cutoff
 *                                false:           T=1 above cutoff
 *   - transitionWidthNm: number — smooth ramp half-width (default 0 = hard edge)
 *
 * The hard-edge model is fine for most paraxial scene simulation; the
 * smooth ramp gives realistic behaviour for beams within ±widthNm of
 * the cutoff.
 *
 * q-parameter: slab propagation through coating thickness, L/n. For
 * reflect we still propagate q through the coating slab (small effect).
 * Power is conserved overall (transmit + reflect = 1) at any λ.
 */

import {
  type BeamRay,
  vec3Distance,
} from "../../beam-ray";
import { type Complex, cAdd, cDiv } from "../../fiber/gaussian";
import { reflect as reflectDirection } from "../../geometry";
import { rotateJonesIntoNewFrame } from "../../jones";
import {
  type PhysicsOp,
  type PhysicsOpContext,
  registerKind,
} from "../../registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyAbcdToQ(A: number, B: number, C: number, D: number, q: Complex): Complex {
  const Aq: Complex = { re: A * q.re, im: A * q.im };
  const Bc: Complex = { re: B, im: 0 };
  const Cq: Complex = { re: C * q.re, im: C * q.im };
  const Dc: Complex = { re: D, im: 0 };
  return cDiv(cAdd(Aq, Bc), cAdd(Cq, Dc));
}

/** Transmittance T(λ) ∈ [0, 1] for a dichroic with given cutoff.
 *  Hard edge when transitionWidthNm <= 0. */
export function transmittance(
  lambdaNm: number,
  cutoffNm: number,
  isShortPass: boolean,
  transitionWidthNm: number = 0,
): number {
  if (transitionWidthNm <= 0) {
    if (isShortPass) return lambdaNm < cutoffNm ? 1 : 0;
    return lambdaNm > cutoffNm ? 1 : 0;
  }
  // Smooth sigmoid transition over ±width.
  const x = (lambdaNm - cutoffNm) / transitionWidthNm;
  const sigmoid = 1 / (1 + Math.exp(4 * x));   // steepness factor 4
  return isShortPass ? sigmoid : 1 - sigmoid;
}

function readDichroicParams(ctx: PhysicsOpContext): {
  cutoffNm: number;
  isShortPass: boolean;
  widthNm: number;
} {
  return {
    cutoffNm: (ctx.params.cutoffWavelengthNm as number | undefined) ?? 700,
    isShortPass: (ctx.params.isShortPass as boolean | undefined) ?? true,
    widthNm: (ctx.params.transitionWidthNm as number | undefined) ?? 0,
  };
}

function readSlabB(ctx: PhysicsOpContext): number {
  // Dichroic coating + substrate. Default 6mm fused silica.
  const L = (ctx.params.substrateThicknessMm as number | undefined) ?? 6;
  const n = (ctx.params.refractiveIndex as number | undefined) ?? 1.4585;
  return L / n;
}

// ---------------------------------------------------------------------------
// dichroic_transmit
// ---------------------------------------------------------------------------

export const dichroicTransmitOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  const { cutoffNm, isShortPass, widthNm } = readDichroicParams(ctx);
  const T = transmittance(rayIn.wavelengthNm, cutoffNm, isShortPass, widthNm);
  const newPower = rayIn.powerMw * T;

  const B = readSlabB(ctx);
  const qxOut = applyAbcdToQ(1, B, 0, 1, rayIn.qx);
  const qyOut = applyAbcdToQ(1, B, 0, 1, rayIn.qy);

  // Direction unchanged. Exit at face_out position.
  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
  );

  return [{
    ...rayIn,
    origin: ctx.faceOut.positionMmBodyLocal,
    qx: qxOut,
    qy: qyOut,
    powerMw: newPower,
    pathLengthMm: rayIn.pathLengthMm + thickness,
  }];
};

// ---------------------------------------------------------------------------
// dichroic_reflect
// ---------------------------------------------------------------------------

export const dichroicReflectOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  const { cutoffNm, isShortPass, widthNm } = readDichroicParams(ctx);
  const T = transmittance(rayIn.wavelengthNm, cutoffNm, isShortPass, widthNm);
  const newPower = rayIn.powerMw * (1 - T);

  // Reflect off internal dichroic coating B1 (typically 45° to optical axis).
  // See asset-physics-model.md §3.3.
  if (!ctx.faceVia || ctx.faceVia.length === 0) {
    throw new Error(
      "dichroic_reflect: transition.via must include the internal coating "
      + "(typically [B1]); see asset-physics-model.md §3.3",
    );
  }
  const b1 = ctx.faceVia[0]!;
  if (!b1.normalBodyLocal) {
    throw new Error(`dichroic_reflect: face '${b1.id}' missing normal`);
  }
  const dirOut = reflectDirection(rayIn.direction, b1.normalBodyLocal);
  const newJones = rotateJonesIntoNewFrame(rayIn.jones, rayIn.direction, dirOut);

  const B = readSlabB(ctx);
  const qxOut = applyAbcdToQ(1, B, 0, 1, rayIn.qx);
  const qyOut = applyAbcdToQ(1, B, 0, 1, rayIn.qy);

  // Origin stays at face_in (mirror-like). Use face_out.position for the
  // exit ray's origin so the caller can render the reflected leg from
  // the labeled spot, but for an axis-aligned setup these coincide.
  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
  );

  return [{
    ...rayIn,
    origin: ctx.faceOut.positionMmBodyLocal,
    direction: dirOut,
    jones: newJones,
    qx: qxOut,
    qy: qyOut,
    powerMw: newPower,
    pathLengthMm: rayIn.pathLengthMm + thickness,
  }];
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerKind("dichroic_mirror", {
  ops: {
    dichroic_transmit: dichroicTransmitOp,
    dichroic_reflect: dichroicReflectOp,
  },
  needsAperture: true,
});
