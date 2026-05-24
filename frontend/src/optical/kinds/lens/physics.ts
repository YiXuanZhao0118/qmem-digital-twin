/**
 * Lens PhysicsOp — thin-lens ABCD transformation on a BeamRay's q-parameter,
 * with the chief ray geometrically propagated from face_in to face_out
 * along its current direction.
 *
 * Wraps the existing `mThinLens` constructor from `generalizedAbcd.ts`
 * (5×5 matrix form). Only the q-parameter update uses the matrix;
 * Jones, power, and direction pass through unchanged (a thin lens is
 * polarization-preserving and lossless in the ideal model).
 *
 * Op name: `abcd_thin_lens`
 * Kind:    `lens`
 * Required params: `focalLengthMm: number`
 */

import {
  type BeamRay,
  vec3Add,
  vec3Distance,
  vec3Scale,
  vec3Sub,
} from "../../beam-ray";
import { type Complex, cAdd, cDiv, cMul } from "../../fiber/gaussian";
import { mThinLens } from "../../generalizedAbcd";
import {
  type PhysicsOp,
  type PhysicsOpContext,
  registerKind,
} from "../../registry";

// ---------------------------------------------------------------------------
// q-parameter ABCD update
// ---------------------------------------------------------------------------

/** Apply a 2×2 ABCD matrix to a complex q-parameter:
 *  q_out = (A·q + B) / (C·q + D). */
export function applyAbcdToQ(
  A: number, B: number, C: number, D: number,
  q: Complex,
): Complex {
  const Aq: Complex = { re: A * q.re, im: A * q.im };
  const Bc: Complex = { re: B, im: 0 };
  const Cq: Complex = { re: C * q.re, im: C * q.im };
  const Dc: Complex = { re: D, im: 0 };
  const numer = cAdd(Aq, Bc);
  const denom = cAdd(Cq, Dc);
  return cDiv(numer, denom);
}

// ---------------------------------------------------------------------------
// Lens op
// ---------------------------------------------------------------------------

export const abcdThinLensOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  // Prefer the transition's explicit 5×5 matrix when supplied — this is
  // how plano-convex lenses encode their direction-aware thick-lens
  // matrices (convex→flat vs flat→convex produce different BFL).
  // Falls back to the symmetric thin-lens matrix derived from focalLengthMm
  // when no explicit matrix is provided (simple use case).
  let M5: number[];
  if (ctx.transferMatrix?.kind === "matrix5x5") {
    M5 = ctx.transferMatrix.M;
  } else {
    const focalMm = (ctx.params.focalLengthMm ?? ctx.params.focalMm) as number | undefined;
    if (typeof focalMm !== "number" || !isFinite(focalMm) || focalMm === 0) {
      throw new Error(
        `abcd_thin_lens: needs transition.matrix5x5 OR valid focalLengthMm; got focal=${JSON.stringify(focalMm)}`,
      );
    }
    M5 = mThinLens(focalMm);
  }
  // 5×5 row-major: row r, col c → M5[r*5 + c]
  // x sub-block: (0,0)=A, (0,1)=B, (1,0)=C, (1,1)=D
  const Ax = M5[0 * 5 + 0], Bx = M5[0 * 5 + 1];
  const Cx = M5[1 * 5 + 0], Dx = M5[1 * 5 + 1];
  // y sub-block: (2,2)=A, (2,3)=B, (3,2)=C, (3,3)=D
  const Ay = M5[2 * 5 + 2], By = M5[2 * 5 + 3];
  const Cy = M5[3 * 5 + 2], Dy = M5[3 * 5 + 3];

  const qxOut = applyAbcdToQ(Ax, Bx, Cx, Dx, rayIn.qx);
  const qyOut = applyAbcdToQ(Ay, By, Cy, Dy, rayIn.qy);

  // Propagate chief ray from face_in to face_out (lens thickness in body-local).
  // For a thin lens, A and B faces sit at ±t/2; we propagate the ray's origin
  // along its current direction by the geometric distance between the two
  // face positions (approximate — thin-lens limit).
  const thicknessMm = vec3Distance(
    ctx.faceIn.positionMmBodyLocal,
    ctx.faceOut.positionMmBodyLocal,
  );
  const newOrigin = vec3Add(rayIn.origin, vec3Scale(rayIn.direction, thicknessMm));

  return [{
    ...rayIn,
    origin: newOrigin,
    qx: qxOut,
    qy: qyOut,
    pathLengthMm: rayIn.pathLengthMm + thicknessMm,
    // direction, jones, wavelength, power, phase: unchanged
  }];
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerKind("lens", {
  ops: {
    abcd_thin_lens: abcdThinLensOp,
  },
  needsAperture: true,
});
