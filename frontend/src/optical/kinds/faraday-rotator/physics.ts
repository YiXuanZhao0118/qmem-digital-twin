/**
 * Faraday Rotator PhysicsOp — non-reciprocal polarization rotation
 * plus glass-slab geometric propagation.
 *
 * Op name: `faraday_rotate`
 * Kind:    `faraday_rotator`
 *
 * Behavior:
 *   - Jones rotated by `rotationDeg` in the beam-local s/p frame.
 *     **Non-reciprocal**: both A1→B1 (forward) and A2→B2 (reverse) rotate
 *     by the SAME signed angle. Two passes through a 45° Faraday rotator
 *     accumulate 90°, not 0° — this is how an isolator blocks back-reflections.
 *   - q-parameter propagates through length L of medium index n via
 *     B = L/n.  Caller provides this via `transition.matrix5x5` OR
 *     params {lengthMm, refractiveIndex} — the op derives B from params
 *     if matrix5x5 absent.
 *   - Chief ray exits at face_out position. Power × (1 - 2*arResidualR)
 *     if `arResidualR` is set (Fresnel coating loss, both faces).
 *
 * Required params:
 *   - rotationDeg            (default 45)
 *   - reciprocal             (default false — pure Faraday)
 *   - lengthMm, refractiveIndex  (used when matrix5x5 absent)
 */

import {
  type BeamRay,
  vec3Add,
  vec3Distance,
  vec3Scale,
} from "../../beam-ray";
import { type Complex, cAdd, cDiv, cMul } from "../../fiber/gaussian";
import { rotateJones } from "../../jones";
import {
  type PhysicsOp,
  type PhysicsOpContext,
  registerKind,
} from "../../registry";

function applyAbcdToQ(A: number, B: number, C: number, D: number, q: Complex): Complex {
  const Aq: Complex = { re: A * q.re, im: A * q.im };
  const Bc: Complex = { re: B, im: 0 };
  const Cq: Complex = { re: C * q.re, im: C * q.im };
  const Dc: Complex = { re: D, im: 0 };
  return cDiv(cAdd(Aq, Bc), cAdd(Cq, Dc));
}

/** Derive the geometric B parameter (q' = q + B for slab) either from
 *  the explicit 5×5 / 2×2 matrix on the transition, or from
 *  lengthMm / refractiveIndex in params. */
function deriveSlabB(ctx: PhysicsOpContext): number {
  // 5×5 supplied? B is at (0,1) (x sub-block).
  if (ctx.transferMatrix?.kind === "matrix5x5") {
    return ctx.transferMatrix.M[0 * 5 + 1]!;
  }
  if (ctx.transferMatrix?.kind === "abcd") {
    return ctx.transferMatrix.M[0]![1]!;
  }
  const L = ctx.params.lengthMm as number | undefined;
  const n = (ctx.params.refractiveIndex as number | undefined) ?? 1.0;
  if (typeof L !== "number" || !isFinite(L) || L <= 0) {
    // No length info — assume free-space propagation by face separation.
    return vec3Distance(
      ctx.faceIn.positionMmBodyLocal,
      ctx.faceOut.positionMmBodyLocal,
    );
  }
  return L / n;
}

export const faradayRotateOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  const rotationDeg = (ctx.params.rotationDeg as number | undefined) ?? 45;
  const rotationRad = (rotationDeg * Math.PI) / 180;
  const reciprocal = (ctx.params.reciprocal as boolean | undefined) ?? false;
  // Reciprocal flag is informational — the actual physics is identical to
  // a Faraday rotator going forward; reverse direction with a non-reciprocal
  // element still rotates by +rotationDeg (NOT -rotationDeg). If
  // `reciprocal=true`, reverse direction WOULD rotate by -rotationDeg —
  // but the polarizer/waveplate use that pattern, not faraday. The tracer
  // calls the same op for both A1→B1 and A2→B2; the direction info is in
  // ctx.faceIn.id, but for Faraday we don't branch on it.
  void reciprocal;

  // Faraday rotation is fixed in LAB frame (around B-field axis ≈ body +z).
  // In beam-local s/p, p axis FLIPS sign when propagation reverses, so to
  // keep the LAB rotation consistent we flip the s/p-frame sign for
  // reverse-going beams (dir_body.z < 0). This is what makes the element
  // non-reciprocal: round trip rotates 2× in lab (not 0°).
  // `rotateJones` is a BASIS rotation by +phi (= vector rotation by -phi),
  // hence the leading minus.
  const directionSign = rayIn.direction.z >= 0 ? +1 : -1;
  const newJones = rotateJones(rayIn.jones, -directionSign * rotationRad);

  // q-parameter slab propagation (B = L/n by default).
  const B = deriveSlabB(ctx);
  const qxOut = applyAbcdToQ(1, B, 0, 1, rayIn.qx);
  const qyOut = applyAbcdToQ(1, B, 0, 1, rayIn.qy);

  // AR coating residual (per face — apply twice if both faces coated).
  const arR = (ctx.params.arResidualR as number | undefined) ?? 0;
  const transmittance = (1 - arR) * (1 - arR);   // both faces
  const newPower = rayIn.powerMw * transmittance;

  // Chief ray exits at face_out position along current direction.
  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal,
    ctx.faceOut.positionMmBodyLocal,
  );
  const newOrigin = vec3Add(rayIn.origin, vec3Scale(rayIn.direction, thickness));

  return [{
    ...rayIn,
    origin: newOrigin,
    jones: newJones,
    qx: qxOut,
    qy: qyOut,
    powerMw: newPower,
    pathLengthMm: rayIn.pathLengthMm + thickness,
  }];
};

registerKind("faraday_rotator", {
  ops: {
    faraday_rotate: faradayRotateOp,
  },
  needsAperture: true,
});
