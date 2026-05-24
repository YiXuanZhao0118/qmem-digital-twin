/**
 * Waveplate PhysicsOp — birefringent retarder.
 *
 * Op name: `jones_waveplate`
 * Kind:    `waveplate`
 *
 * Jones matrix in beam-local s/p basis with fast axis at angle θ from +s:
 *
 *   J(δ, θ) = R(-θ) · diag(1, e^(iδ)) · R(θ)
 *
 * Where:
 *   - δ = retardance in radians (HWP: π, QWP: π/2)
 *   - θ = fast-axis angle from +s (degrees in params)
 *   - R(α) = [[cos α, sin α], [-sin α, cos α]]  (this is our `rotateJones`'s
 *            internal matrix — see rotateJones doc)
 *
 * Implementation step-by-step:
 *   1. Express Jones in fast/slow basis: rotateJones(jones, θ)
 *   2. Apply phase delay to slow axis: E_sl *= e^(iδ)
 *   3. Express back in s/p basis: rotateJones(result, -θ)
 *
 * Power conservation: unitary transform, so |jones_out|² = |jones_in|².
 * powerMw passes through unchanged.
 *
 * Required params:
 *   - retardanceDeg (default 90 = QWP). HWP: 180.
 *   - fastAxisDegBeamLocal (default 0)
 *
 * Optional: lengthMm + refractiveIndex for q-parameter slab propagation.
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

/** Apply waveplate Jones matrix to (E_s, E_p) with retardance δ and
 *  fast axis at θ from +s. */
export function applyWaveplate(
  jones: [Complex, Complex],
  retardanceRad: number,
  fastAxisRad: number,
): [Complex, Complex] {
  // 1. Rotate s/p → fast/slow basis
  const [Ef, Esl] = rotateJones(jones, fastAxisRad);

  // 2. Apply phase e^(iδ) to slow axis
  const phaseSlow: Complex = {
    re: Math.cos(retardanceRad),
    im: Math.sin(retardanceRad),
  };
  const EslShifted = cMul(phaseSlow, Esl);

  // 3. Rotate fast/slow → s/p basis
  return rotateJones([Ef, EslShifted], -fastAxisRad);
}

export const jonesWaveplateOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  const retDeg = (ctx.params.retardanceDeg as number | undefined) ?? 90;
  const retardanceRad = (retDeg * Math.PI) / 180;
  const fastDeg = (
    ctx.params.fastAxisDegBeamLocal
    ?? ctx.params.fastAxisDegBodyLocal
    ?? 0
  ) as number;
  const fastAxisRad = (fastDeg * Math.PI) / 180;

  const newJones = applyWaveplate(rayIn.jones, retardanceRad, fastAxisRad);

  // Slab q propagation (q' = q + B with B = L/n).
  const L = (ctx.params.lengthMm ?? ctx.params.thicknessMm) as number | undefined;
  const n = (ctx.params.refractiveIndex as number | undefined) ?? 1.0;
  const B = (typeof L === "number" && L > 0)
    ? L / n
    : vec3Distance(ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal);

  const qxOut = applyAbcdToQ(1, B, 0, 1, rayIn.qx);
  const qyOut = applyAbcdToQ(1, B, 0, 1, rayIn.qy);

  // Chief ray exits at face_out position. Direction unchanged.
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
    pathLengthMm: rayIn.pathLengthMm + thickness,
    // power conserved (unitary)
  }];
};

registerKind("waveplate", {
  ops: {
    jones_waveplate: jonesWaveplateOp,
  },
  needsAperture: true,
});
