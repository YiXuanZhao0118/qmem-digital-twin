/**
 * Polarizer PhysicsOp — ideal linear polarizer with transmission axis
 * at angle `transmissionAxisDegBeamLocal` from beam-local +s.
 *
 * Op name: `jones_polarizer`
 * Kind:    `polarizer`
 *
 * Math:
 *   J(θ) = [ c²    cs  ]      where c = cos θ, s = sin θ
 *          [ cs    s²  ]
 *   jones_out = J · jones_in
 *
 *   Power update: out.power = in.power × |jones_out|² / |jones_in|²
 *   Jones is then renormalized to unit magnitude (so |jones|² ≡ 1 always).
 *
 * Convention:
 *   - Input ray.jones is in beam-local s/p frame (the ray tracer is
 *     responsible for rotating into this frame before invoking the op).
 *   - `transmissionAxisDegBeamLocal = 0` ⇒ transmits +s component (E_s)
 *     and blocks +p (E_p) — Malus law E ∝ cos(θ).
 *
 * Chief ray propagates face_in → face_out along current direction.
 */

import {
  type BeamRay,
  vec3Add,
  vec3Distance,
  vec3Scale,
} from "../../beam-ray";
import { type Complex, cAdd, cMul } from "../../fiber/gaussian";
import {
  type PhysicsOp,
  type PhysicsOpContext,
  registerKind,
} from "../../registry";

function realC(x: number): Complex {
  return { re: x, im: 0 };
}

/** Apply 2×2 real Jones matrix (linear polarizer) to a complex Jones vector. */
export function applyLinearPolarizer(
  jones: [Complex, Complex],
  thetaRad: number,
): [Complex, Complex] {
  const c = Math.cos(thetaRad);
  const s = Math.sin(thetaRad);
  const cc = realC(c * c);
  const cs = realC(c * s);
  const ss = realC(s * s);
  const [Es, Ep] = jones;
  return [
    cAdd(cMul(cc, Es), cMul(cs, Ep)),
    cAdd(cMul(cs, Es), cMul(ss, Ep)),
  ];
}

function jonesMagnitudeSquared(jones: [Complex, Complex]): number {
  const [Es, Ep] = jones;
  return Es.re * Es.re + Es.im * Es.im + Ep.re * Ep.re + Ep.im * Ep.im;
}

export const jonesPolarizerOp: PhysicsOp = (
  rayIn: BeamRay,
  ctx: PhysicsOpContext,
): BeamRay[] => {
  const axisDeg = (
    ctx.params.transmissionAxisDegBeamLocal
    ?? ctx.params.transmissionAxisDegBodyLocal
    ?? 0
  ) as number;
  const theta = (axisDeg * Math.PI) / 180;

  const jonesProjected = applyLinearPolarizer(rayIn.jones, theta);
  const magSqIn = jonesMagnitudeSquared(rayIn.jones);
  const magSqOut = jonesMagnitudeSquared(jonesProjected);

  // Transmittance (relative to input magnitude). Guard against zero input.
  const t = magSqIn > 1e-30 ? magSqOut / magSqIn : 0;
  const newPower = rayIn.powerMw * t;

  // Renormalize Jones to unit magnitude (or keep as input if blocked).
  let newJones: [Complex, Complex];
  if (magSqOut > 1e-30) {
    const norm = 1 / Math.sqrt(magSqOut);
    newJones = [
      { re: jonesProjected[0].re * norm, im: jonesProjected[0].im * norm },
      { re: jonesProjected[1].re * norm, im: jonesProjected[1].im * norm },
    ];
  } else {
    // Beam fully blocked — Jones direction undefined; keep input for safety.
    newJones = rayIn.jones;
  }

  // Chief ray propagates face_in → face_out along current direction.
  const thicknessMm = vec3Distance(
    ctx.faceIn.positionMmBodyLocal,
    ctx.faceOut.positionMmBodyLocal,
  );
  const newOrigin = vec3Add(rayIn.origin, vec3Scale(rayIn.direction, thicknessMm));

  return [{
    ...rayIn,
    origin: newOrigin,
    jones: newJones,
    powerMw: newPower,
    pathLengthMm: rayIn.pathLengthMm + thicknessMm,
  }];
};

registerKind("polarizer", {
  ops: {
    jones_polarizer: jonesPolarizerOp,
  },
  needsAperture: true,
});

// Variant ops (Glan-Laser PBS-like rejection) register themselves under
// the polarizer kind via registerOps when imported. The eager-import in
// kinds/__init__ guarantees ordering: polarizer first, then glan-laser.

