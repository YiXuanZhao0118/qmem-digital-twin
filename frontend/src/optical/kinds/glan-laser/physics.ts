/**
 * Glan-Laser Calcite Prism PhysicsOps — physically-correct multi-hop
 * topology (see asset-physics-model.md §3.3).
 *
 *   Faces:  A1 (input), A2 (transmit out), A3 (reject side exit),
 *           B1, B2 (gap interfaces — real surface normals)
 *   Transitions:
 *     A1 → A2  via [B1, B2]   glan_transmit_p   (p Snell across gap)
 *     A1 → A3  via [B1]       glan_reject_s     (s TIR at gap, Snell at A3)
 *     A2 → A1  via [B2, B1]   glan_transmit_p   (reverse p)
 *     A2 → A3  via [B2]       glan_reject_s     (reverse reject, rarely fired)
 *
 * s-pol (o-ray, n_o≈1.66) undergoes TIR at B1; p-pol (e-ray, n_e≈1.48)
 * transmits. Exit direction at A3 is derived from mirror+Snell using B1
 * and A3 real surface normals — NOT hard-coded.
 */

import {
  type BeamRay,
  vec3Distance,
} from "../../beam-ray";
import { type Complex, cAdd, cDiv } from "../../fiber/gaussian";
import { reflect, refract } from "../../geometry";
import {
  type PhysicsOp,
  type PhysicsOpContext,
  registerOps,
} from "../../registry";
import { applyLinearPolarizer } from "../polarizer/physics";

// Eager-import pbs/physics ensures registerKind("pbs", ...) has run
// before our registerOps call below. Also pull polarizer's helper.
import "../pbs/physics";
import "../polarizer/physics";

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

// ---------------------------------------------------------------------------
// glan_transmit_p — p polarization transmits through both gap surfaces
// ---------------------------------------------------------------------------

export const glanTransmitPOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  const { jones, power } = projectAndUpdate(rayIn.jones, rayIn.powerMw, 0);

  let Bx = 0, By = 0;
  if (ctx.transferMatrix?.kind === "matrix5x5") {
    const M5 = ctx.transferMatrix.M;
    Bx = M5[0 * 5 + 1]!;
    By = M5[2 * 5 + 3]!;
  } else {
    const L = (ctx.params.lengthMm as number | undefined) ?? vec3Distance(
      ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
    );
    const ne = (ctx.params.refractiveIndex_e as number | undefined)
            ?? (ctx.params.refractiveIndex as number | undefined) ?? 1.48;
    Bx = L / ne;
    By = L / ne;
  }
  const qxOut = applyAbcdToQ(1, Bx, 0, 1, rayIn.qx);
  const qyOut = applyAbcdToQ(1, By, 0, 1, rayIn.qy);

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
// glan_reject_s — s polarization TIR at gap, then Snell at side exit
// ---------------------------------------------------------------------------

export const glanRejectSOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  const { jones, power } = projectAndUpdate(rayIn.jones, rayIn.powerMw, 90);

  if (!ctx.faceVia || ctx.faceVia.length === 0) {
    throw new Error(
      "glan_reject_s: transition.via must include the gap interface "
      + "(typically [B1]); see asset-physics-model.md §3.3",
    );
  }
  const b1 = ctx.faceVia[0]!;
  if (!b1.normalBodyLocal) {
    throw new Error(`glan_reject_s: face '${b1.id}' missing normal`);
  }
  if (!ctx.faceOut.normalBodyLocal) {
    throw new Error(`glan_reject_s: face '${ctx.faceOut.id}' missing normal`);
  }

  // 1) TIR reflect at the gap (beam still in crystal).
  const dirInCrystal = reflect(rayIn.direction, b1.normalBodyLocal);

  // 2) Snell-refract through A3 from crystal (n_o for o-ray = s pol) to air.
  const nO = (ctx.params.refractiveIndex_o as number | undefined) ?? 1.66;
  const dirAir = refract(dirInCrystal, ctx.faceOut.normalBodyLocal, nO, 1.0);

  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
  );

  return [{
    ...rayIn,
    origin: ctx.faceOut.positionMmBodyLocal,
    direction: dirAir,
    jones,
    powerMw: power,
    pathLengthMm: rayIn.pathLengthMm + thickness,
  }];
};

// ---------------------------------------------------------------------------
// Register both ops under existing pbs kind
// ---------------------------------------------------------------------------

registerOps("pbs", {
  glan_transmit_p: glanTransmitPOp,
  glan_reject_s: glanRejectSOp,
});
