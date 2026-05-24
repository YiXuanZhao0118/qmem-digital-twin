/**
 * PBS (Polarizing Beam Splitter) PhysicsOps.
 *
 * Multi-hop topology (see asset-physics-model.md §3.3):
 *
 *   Faces:  A1..A4 external (back/front/left/right cube faces),
 *           B1 internal Brewster plate (45° diagonal)
 *   Transitions:
 *     A1 → A_opposite via [B1]   pbs_transmit_p   (p through plate)
 *     A1 → A_side     via [B1]   pbs_reflect_s    (s mirror reflect at B1)
 *
 * pbs_reflect_s computes exit direction via `k_out = k_in − 2(k·n̂_B1)n̂_B1`
 * using face_via[0]'s real surface normal. The single-plate geometry
 * pairs back↔front and left↔right for transmit, back↔right + front↔left
 * for reflect (with plate normal (-0.7071, 0, 0.7071) by convention).
 */

import {
  type BeamRay,
  vec3Distance,
} from "../../beam-ray";
import { type Complex, cAdd, cDiv } from "../../fiber/gaussian";
import { reflect } from "../../geometry";
import {
  type PhysicsOp,
  type PhysicsOpContext,
  registerKind,
} from "../../registry";
import { applyLinearPolarizer } from "../polarizer/physics";

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

function jonesMagSq(jones: [Complex, Complex]): number {
  const [Es, Ep] = jones;
  return Es.re * Es.re + Es.im * Es.im + Ep.re * Ep.re + Ep.im * Ep.im;
}

/** Apply a polarizer-style projection at `axisDegBeamLocal`, update
 *  power by transmittance, renormalize Jones to unit magnitude. */
function projectAndUpdate(
  jonesIn: [Complex, Complex], powerIn: number, axisDegBeamLocal: number,
): { jones: [Complex, Complex]; power: number } {
  const projected = applyLinearPolarizer(
    jonesIn, (axisDegBeamLocal * Math.PI) / 180,
  );
  const magIn = jonesMagSq(jonesIn);
  const magOut = jonesMagSq(projected);
  const t = magIn > 1e-30 ? magOut / magIn : 0;
  const power = powerIn * t;
  if (magOut > 1e-30) {
    const norm = 1 / Math.sqrt(magOut);
    return {
      jones: [
        { re: projected[0].re * norm, im: projected[0].im * norm },
        { re: projected[1].re * norm, im: projected[1].im * norm },
      ],
      power,
    };
  }
  return { jones: jonesIn, power };
}

function readSlabParams(ctx: PhysicsOpContext): { B: number } {
  // Effective glass slab length / refractive index. For PBS the path
  // through the cube depends on whether transmit (straight line) or
  // reflect (right-angle path through diagonal). Both legs have
  // approximately the same path length d in a unit cube; the user can
  // override via params.cubeSizeMm + refractiveIndex.
  const d = (ctx.params.cubeSizeMm as number | undefined)
    ?? vec3Distance(
      ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
    );
  const n = (ctx.params.refractiveIndex as number | undefined) ?? 1.5168;
  return { B: d / n };
}

// ---------------------------------------------------------------------------
// pbs_transmit_p
// ---------------------------------------------------------------------------

export const pbsTransmitPOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  // Beam-local +s == PBS "P" (in plane of incidence).
  const { jones, power } = projectAndUpdate(rayIn.jones, rayIn.powerMw, 0);

  const { B } = readSlabParams(ctx);
  const qxOut = applyAbcdToQ(1, B, 0, 1, rayIn.qx);
  const qyOut = applyAbcdToQ(1, B, 0, 1, rayIn.qy);

  // Direction unchanged (straight through).
  // Exit at face_out.position.
  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
  );

  return [{
    ...rayIn,
    origin: ctx.faceOut.positionMmBodyLocal,
    jones,
    qx: qxOut,
    qy: qyOut,
    powerMw: power,
    pathLengthMm: rayIn.pathLengthMm + thickness,
  }];
};

// ---------------------------------------------------------------------------
// pbs_reflect_s
// ---------------------------------------------------------------------------

export const pbsReflectSOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  // Beam-local +p == PBS "S" (perpendicular to plane of incidence).
  const { jones, power } = projectAndUpdate(rayIn.jones, rayIn.powerMw, 90);

  const { B } = readSlabParams(ctx);
  const qxOut = applyAbcdToQ(1, B, 0, 1, rayIn.qx);
  const qyOut = applyAbcdToQ(1, B, 0, 1, rayIn.qy);

  if (!ctx.faceVia || ctx.faceVia.length === 0) {
    throw new Error(
      "pbs_reflect_s: transition.via must include the internal Brewster "
      + "plate (typically [B1]); see asset-physics-model.md §3.3",
    );
  }
  const b1 = ctx.faceVia[0]!;
  if (!b1.normalBodyLocal) {
    throw new Error(`pbs_reflect_s: face '${b1.id}' missing normal`);
  }
  const dirOut = reflect(rayIn.direction, b1.normalBodyLocal);

  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
  );

  return [{
    ...rayIn,
    origin: ctx.faceOut.positionMmBodyLocal,
    direction: dirOut,
    jones,
    qx: qxOut,
    qy: qyOut,
    powerMw: power,
    pathLengthMm: rayIn.pathLengthMm + thickness,
  }];
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerKind("pbs", {
  ops: {
    pbs_transmit_p: pbsTransmitPOp,
    pbs_reflect_s: pbsReflectSOp,
  },
  needsAperture: true,
});
