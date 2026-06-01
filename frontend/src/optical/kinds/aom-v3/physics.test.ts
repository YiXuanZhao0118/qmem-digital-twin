/**
 * Vitest for v3 AOM op. Verifies:
 *   - v3 A1/B1/A2/B2 face topology and legacy B0/B+1/B-1 parsing
 *   - Bragg angle formula
 *   - +1 order direction tilted along the RF propagation side
 *   - 0 order direction unchanged
 *   - -1 order direction tilted to the opposite side
 *   - efficiency split
 *   - q-parameter slab propagation
 */

import { describe, it, expect } from "vitest";
import "./physics";

import { type BeamRay, makeBeamRay } from "../../beam-ray";
import { type Face, type PhysicsOpContext, getOp } from "../../registry";
import {
  braggAcceptanceMrad,
  braggAngleRad,
  braggDetuningFactor,
  orderEfficiency,
  orderFromContext,
  parseOrderFromFaceId,
} from "./physics";

const L = 1.6;  // crystal length mm

const FACE_A1: Face = {
  id: "A1",
  positionMmBodyLocal: { x: 0, y: 0, z: -L / 2 },
  normalBodyLocal: { x: 0, y: 0, z: -1 },
  apertureMm: 1.0, apertureShape: "circle",
};
const FACE_B1: Face = {
  id: "B1",
  positionMmBodyLocal: { x: 0, y: 0, z: L / 2 },
  normalBodyLocal: { x: 0, y: 0, z: 1 },
  apertureMm: 1.0, apertureShape: "circle",
};
const FACE_A2: Face = { ...FACE_B1, id: "A2" };
const FACE_B2: Face = { ...FACE_A1, id: "B2" };

const FACE_A_LEGACY: Face = { ...FACE_A1, id: "A" };
function legacyFaceB(order: number): Face {
  return {
    id: `B${order > 0 ? "+" : ""}${order}`,
    positionMmBodyLocal: { x: 0, y: 0, z: L / 2 },
    normalBodyLocal: { x: 0, y: 0, z: 1 },
    apertureMm: 1.0, apertureShape: "circle",
  };
}

function forwardRay(): BeamRay {
  return makeBeamRay({
    origin: { x: 0, y: 0, z: -L / 2 },
    direction: { x: 0, y: 0, z: 1 },
    wavelengthNm: 780,
    powerMw: 1.0,
  });
}

function reverseRay(): BeamRay {
  return makeBeamRay({
    origin: { x: 0, y: 0, z: L / 2 },
    direction: { x: 0, y: 0, z: -1 },
    wavelengthNm: 780,
    powerMw: 1.0,
  });
}

function ctxForFaces(
  faceIn: Face,
  faceOut: Face,
  paramOverrides: Record<string, unknown> = {},
  dynamic?: Record<string, unknown>,
): PhysicsOpContext {
  return {
    faceIn,
    faceOut,
    params: {
      centerFreqMhz: 80,
      acousticVelocityMps: 4200,
      refractiveIndex: 2.26,
      crystalLengthMm: L,
      baseEfficiency: 0.85,
      ...paramOverrides,
    },
    dynamic,
  };
}

function ctxFor(order: number, paramOverrides: Record<string, unknown> = {}): PhysicsOpContext {
  if (order === 1) return ctxForFaces(FACE_A1, FACE_B1, paramOverrides);
  if (order === -1) return ctxForFaces(FACE_A2, FACE_B2, paramOverrides);
  return ctxForFaces(FACE_A1, FACE_B1, { order, ...paramOverrides });
}

function legacyCtxFor(order: number): PhysicsOpContext {
  return ctxForFaces(FACE_A_LEGACY, legacyFaceB(order));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("AOM / helpers", () => {
  it("parseOrderFromFaceId: B0 -> 0", () => {
    expect(parseOrderFromFaceId("B0")).toBe(0);
  });
  it("parseOrderFromFaceId: B+1 -> +1", () => {
    expect(parseOrderFromFaceId("B+1")).toBe(1);
  });
  it("parseOrderFromFaceId: B-2 -> -2", () => {
    expect(parseOrderFromFaceId("B-2")).toBe(-2);
  });
  it("parseOrderFromFaceId: invalid throws", () => {
    expect(() => parseOrderFromFaceId("A")).toThrowError();
    expect(() => parseOrderFromFaceId("Bxyz")).toThrowError();
  });

  it("orderFromContext: A1->B1 is +1, A2->B2 is -1, explicit order wins", () => {
    expect(orderFromContext(ctxForFaces(FACE_A1, FACE_B1))).toBe(1);
    expect(orderFromContext(ctxForFaces(FACE_A2, FACE_B2))).toBe(-1);
    expect(orderFromContext(ctxForFaces(FACE_A1, FACE_B1, { order: 0 }))).toBe(0);
    expect(orderFromContext(legacyCtxFor(1))).toBe(1);
  });

  it("braggAngleRad: 780nm / 80MHz / 4200 m/s / n=2.26", () => {
    const theta = braggAngleRad(780, 80, 4200, 2.26);
    // External-angle convention: asin(lambda * f / (2 * v)).
    expect(theta).toBeCloseTo(7.429e-3, 6);
  });

  it("orderEfficiency: +1 -> base, 0 -> 1-base, -1 -> 1%*base, other -> 0", () => {
    expect(orderEfficiency(1, 0.85)).toBe(0.85);
    expect(orderEfficiency(0, 0.85)).toBeCloseTo(0.15, 12);
    expect(orderEfficiency(-1, 0.85)).toBeCloseTo(0.0085, 12);
    expect(orderEfficiency(2, 0.85)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Op behavior
// ---------------------------------------------------------------------------

describe("AOM / diffract_aom op", () => {
  it("registers", () => {
    const op = getOp("aom", "diffract_aom");
    expect(typeof op).toBe("function");
  });

  it("0 order: direction unchanged, power = 1 - eta", () => {
    const op = getOp("aom", "diffract_aom");
    const [out] = op(forwardRay(), ctxFor(0));
    expect(out.direction.x).toBeCloseTo(0, 12);
    expect(out.direction.z).toBeCloseTo(1, 12);
    expect(out.powerMw).toBeCloseTo(0.15, 12);
  });

  it("A1 -> B1: +1 order follows RF +x side", () => {
    const op = getOp("aom", "diffract_aom");
    const [out] = op(forwardRay(), ctxFor(1));
    const thetaB = braggAngleRad(780, 80, 4200, 2.26);
    const expectedDeflect = 2 * thetaB;
    expect(out.direction.x).toBeCloseTo(Math.sin(expectedDeflect), 9);
    expect(out.direction.z).toBeCloseTo(Math.cos(expectedDeflect), 9);
    expect(out.direction.y).toBeCloseTo(0, 12);
    expect(out.powerMw).toBeCloseTo(0.85, 12);
  });

  it("A2 -> B2: -1 order exits from the opposite optical side", () => {
    const op = getOp("aom", "diffract_aom");
    const [out] = op(reverseRay(), ctxFor(-1));
    const thetaB = braggAngleRad(780, 80, 4200, 2.26);
    expect(out.direction.x).toBeCloseTo(-Math.sin(2 * thetaB), 9);
    expect(out.direction.z).toBeCloseTo(-Math.cos(2 * thetaB), 9);
    expect(out.powerMw).toBeCloseTo(0.0085, 12);
  });

  it("RF direction controls which side the +1 order exits", () => {
    const op = getOp("aom", "diffract_aom");
    const [out] = op(
      forwardRay(),
      ctxForFaces(FACE_A1, FACE_B1, {}, { rfPropagationDirectionBodyLocal: [-1, 0, 0] }),
    );
    const thetaB = braggAngleRad(780, 80, 4200, 2.26);
    expect(out.direction.x).toBeCloseTo(-Math.sin(2 * thetaB), 9);
  });

  it("rejects RF vectors that are not perpendicular to the A->B axis", () => {
    const op = getOp("aom", "diffract_aom");
    expect(() => op(
      forwardRay(),
      ctxForFaces(FACE_A1, FACE_B1, {}, { rfPropagationDirectionBodyLocal: [0, 0, 1] }),
    )).toThrowError(/perpendicular/);
  });

  it("sum of order powers ~1 (eta + (1-eta) + small)", () => {
    const op = getOp("aom", "diffract_aom");
    const p0 = op(forwardRay(), ctxFor(0))[0]!.powerMw;
    const pp1 = op(forwardRay(), ctxFor(1))[0]!.powerMw;
    const pm1 = op(reverseRay(), ctxFor(-1))[0]!.powerMw;
    expect(p0 + pp1 + pm1).toBeCloseTo(1.0085, 12);  // small overshoot from -1 order
  });

  it("dynamic.aomFreqMhz overrides centerFreqMhz", () => {
    const op = getOp("aom", "diffract_aom");
    const ctx: PhysicsOpContext = {
      ...ctxFor(1),
      dynamic: { aomFreqMhz: 110 },
    };
    const [out] = op(forwardRay(), ctx);
    const thetaB110 = braggAngleRad(780, 110, 4200, 2.26);
    expect(out.direction.x).toBeCloseTo(Math.sin(2 * thetaB110), 9);
  });

  it("requiresRfDrive gates first order off when no real RF signal is resolved", () => {
    const op = getOp("aom", "diffract_aom");
    const [plus] = op(forwardRay(), ctxFor(1, { requiresRfDrive: true }));
    const [zero] = op(forwardRay(), ctxFor(0, { requiresRfDrive: true }));
    expect(plus.powerMw).toBeCloseTo(0, 12);
    expect(zero.powerMw).toBeCloseTo(1, 12);
  });

  it("uses post-chain RF drive power for closed-form efficiency", () => {
    const op = getOp("aom", "diffract_aom");
    const ctx: PhysicsOpContext = {
      ...ctxFor(1, {
        figureOfMeritM2: 1e-10,
        acousticBeamWidthMm: 1.5,
        rfPowerMaxW: 0.01,
      }),
      dynamic: { rfDrivePowerW: 0.1 },
    };
    const [out] = op(forwardRay(), ctx);
    const theta = braggAngleRad(780, 80, 4200, 2.26);
    const lambdaM = 780e-9;
    const Lm = L * 1e-3;
    const Wm = 1.5e-3;
    const expected = Math.sin(
      ((Math.PI * Lm) / (2 * lambdaM * Math.cos(theta)))
      * Math.sqrt((2 * 1e-10 * 0.01) / Wm),
    ) ** 2;
    expect(out.powerMw).toBeCloseTo(expected, 12);
  });

  it("q-parameter propagates by L/n", () => {
    const op = getOp("aom", "diffract_aom");
    const r = forwardRay();
    const [out] = op(r, ctxFor(0));
    const B = L / 2.26;
    expect(out.qx.re).toBeCloseTo(r.qx.re + B, 9);
  });

  it("exit origin at faceOut position", () => {
    const op = getOp("aom", "diffract_aom");
    const [out] = op(forwardRay(), ctxFor(1));
    expect(out.origin.z).toBeCloseTo(L / 2, 12);
  });

  it("jones unchanged (polarization-preserving)", () => {
    const op = getOp("aom", "diffract_aom");
    const r = forwardRay();
    const [out] = op(r, ctxFor(1));
    expect(out.jones).toEqual(r.jones);
  });
});

// ---------------------------------------------------------------------------
// Doppler frequency shift (tracked as freqOffsetHz; wavelengthNm untouched)
// ---------------------------------------------------------------------------

describe("AOM / Doppler frequency shift", () => {
  it("+1 order shifts by +f_RF", () => {
    const op = getOp("aom", "diffract_aom");
    const [out] = op(forwardRay(), ctxFor(1));
    expect(out.freqOffsetHz).toBeCloseTo(80e6, 0);
  });

  it("0 order: no shift", () => {
    const op = getOp("aom", "diffract_aom");
    const [out] = op(forwardRay(), ctxFor(0));
    expect(out.freqOffsetHz).toBeCloseTo(0, 6);
  });

  it("-1 order shifts by -f_RF", () => {
    const op = getOp("aom", "diffract_aom");
    const [out] = op(reverseRay(), ctxFor(-1));
    expect(out.freqOffsetHz).toBeCloseTo(-80e6, 0);
  });

  it("accumulates onto an existing offset", () => {
    const op = getOp("aom", "diffract_aom");
    const r = { ...forwardRay(), freqOffsetHz: 80e6 };
    const [out] = op(r, ctxFor(1));
    expect(out.freqOffsetHz).toBeCloseTo(160e6, 0);
  });

  it("uses dynamic.aomFreqMhz", () => {
    const op = getOp("aom", "diffract_aom");
    const ctx: PhysicsOpContext = { ...ctxFor(1), dynamic: { aomFreqMhz: 110 } };
    const [out] = op(forwardRay(), ctx);
    expect(out.freqOffsetHz).toBeCloseTo(110e6, 0);
  });

  it("leaves wavelengthNm on the nominal carrier", () => {
    const op = getOp("aom", "diffract_aom");
    const r = forwardRay();
    const [out] = op(r, ctxFor(1));
    expect(out.wavelengthNm).toBe(r.wavelengthNm);
  });
});

// ---------------------------------------------------------------------------
// Bragg detuning sinc^2 (off-axis incidence reduces diffraction efficiency)
// ---------------------------------------------------------------------------

function tiltedRay(angleRad: number): BeamRay {
  return makeBeamRay({
    origin: { x: 0, y: 0, z: -L / 2 },
    direction: { x: Math.sin(angleRad), y: 0, z: Math.cos(angleRad) },
    wavelengthNm: 780,
    powerMw: 1.0,
  });
}

describe("AOM / Bragg detuning", () => {
  it("acceptance = n·v/(f·L), in mrad", () => {
    expect(braggAcceptanceMrad(80, 4200, 2.26, L)).toBeCloseTo(74.16, 1);
  });

  it("on-axis input: detuning factor 1", () => {
    const f = braggDetuningFactor(forwardRay(), ctxFor(1), 80, 4200, 2.26, L);
    expect(f).toBeCloseTo(1, 12);
  });

  it("at the first null (Δθ = acceptance): factor → 0", () => {
    const nullRad = braggAcceptanceMrad(80, 4200, 2.26, L) * 1e-3;
    const f = braggDetuningFactor(tiltedRay(nullRad), ctxFor(1), 80, 4200, 2.26, L);
    expect(f).toBeCloseTo(0, 6);
  });

  it("at half the null: factor ≈ sinc²(π/2)", () => {
    const nullRad = braggAcceptanceMrad(80, 4200, 2.26, L) * 1e-3;
    const f = braggDetuningFactor(tiltedRay(nullRad / 2), ctxFor(1), 80, 4200, 2.26, L);
    expect(f).toBeCloseTo((2 / Math.PI) ** 2, 4);
  });

  it("off-axis input reduces first-order power", () => {
    const op = getOp("aom", "diffract_aom");
    const nullRad = braggAcceptanceMrad(80, 4200, 2.26, L) * 1e-3;
    const [out] = op(tiltedRay(nullRad / 2), ctxFor(1));
    expect(out.powerMw).toBeCloseTo(0.85 * (2 / Math.PI) ** 2, 4);
  });
});
