/**
 * Vitest for dichroic mirror ops. Verifies:
 *   - T(λ) hard cutoff: below = 1, above = 0 (shortpass)
 *   - dichroic_transmit: λ in transmit band → full power, in reflect band → 0
 *   - dichroic_reflect: λ in reflect band → full power, direction reflects
 *   - Smooth transition with widthNm
 *   - Sum (transmit + reflect) = 1 power conservation
 */

import { describe, it, expect } from "vitest";
import "./physics";

import { type BeamRay, makeBeamRay } from "../../beam-ray";
import { type Face, type PhysicsOpContext, getOp } from "../../registry";
import { transmittance } from "./physics";

const SQRT_HALF = Math.SQRT1_2;

const FACE_A: Face = {
  id: "A",
  positionMmBodyLocal: { x: 0, y: 0, z: -12.5 },
  normalBodyLocal: { x: 0, y: 0, z: -1 },
  apertureMm: 12.7, apertureShape: "circle",
};
const FACE_T: Face = {
  id: "Bt",
  positionMmBodyLocal: { x: 0, y: 0, z: 12.5 },
  normalBodyLocal: { x: 0, y: 0, z: 1 },
  apertureMm: 12.7, apertureShape: "circle",
};
const FACE_R: Face = {
  id: "Br",
  positionMmBodyLocal: { x: 12.5, y: 0, z: 0 },
  normalBodyLocal: { x: 1, y: 0, z: 0 },
  apertureMm: 12.7, apertureShape: "circle",
};
// Internal 45° coating, normal toward back-up corner — reflects +z to +x.
const FACE_B1: Face = {
  id: "B1",
  positionMmBodyLocal: { x: 0, y: 0, z: 0 },
  normalBodyLocal: { x: -SQRT_HALF, y: 0, z: SQRT_HALF },
  apertureMm: 17.68, apertureShape: "rectangle",
};

function ray(wavelengthNm: number): BeamRay {
  return makeBeamRay({
    origin: { x: 0, y: 0, z: -5 },
    direction: { x: 0, y: 0, z: 1 },
    wavelengthNm,
    powerMw: 1.0,
  });
}

function ctxTransmit(overrides: Record<string, unknown> = {}): PhysicsOpContext {
  return {
    faceIn: FACE_A, faceOut: FACE_T,
    params: {
      cutoffWavelengthNm: 700,
      isShortPass: true,
      substrateThicknessMm: 6,
      refractiveIndex: 1.4585,
      ...overrides,
    },
    faceVia: [FACE_B1],
  };
}

function ctxReflect(overrides: Record<string, unknown> = {}): PhysicsOpContext {
  return {
    faceIn: FACE_A, faceOut: FACE_R,
    params: {
      cutoffWavelengthNm: 700,
      isShortPass: true,
      substrateThicknessMm: 6,
      refractiveIndex: 1.4585,
      ...overrides,
    },
    faceVia: [FACE_B1],
  };
}

describe("dichroic / transmittance helper", () => {
  it("shortpass hard cutoff: below = 1, above = 0", () => {
    expect(transmittance(650, 700, true)).toBe(1);
    expect(transmittance(750, 700, true)).toBe(0);
  });

  it("longpass hard cutoff: below = 0, above = 1", () => {
    expect(transmittance(650, 700, false)).toBe(0);
    expect(transmittance(750, 700, false)).toBe(1);
  });

  it("smooth transition at cutoff = 0.5", () => {
    const t = transmittance(700, 700, true, 20);
    expect(t).toBeCloseTo(0.5, 9);
  });

  it("smooth transition: well below cutoff ≈ 1", () => {
    const t = transmittance(500, 700, true, 20);
    expect(t).toBeCloseTo(1, 9);
  });
});

describe("dichroic / dichroic_transmit", () => {
  it("registers", () => {
    const op = getOp("dichroic_mirror", "dichroic_transmit");
    expect(typeof op).toBe("function");
  });

  it("transmit-band λ → full power", () => {
    const op = getOp("dichroic_mirror", "dichroic_transmit");
    const [out] = op(ray(650), ctxTransmit());
    expect(out.powerMw).toBeCloseTo(1, 12);
  });

  it("reflect-band λ → blocked from transmit", () => {
    const op = getOp("dichroic_mirror", "dichroic_transmit");
    const [out] = op(ray(800), ctxTransmit());
    expect(out.powerMw).toBeCloseTo(0, 12);
  });

  it("direction unchanged for transmit", () => {
    const op = getOp("dichroic_mirror", "dichroic_transmit");
    const r = ray(650);
    const [out] = op(r, ctxTransmit());
    expect(out.direction).toEqual(r.direction);
  });

  it("exits at face_out.position", () => {
    const op = getOp("dichroic_mirror", "dichroic_transmit");
    const [out] = op(ray(650), ctxTransmit());
    expect(out.origin.z).toBeCloseTo(12.5, 12);
  });
});

describe("dichroic / dichroic_reflect", () => {
  it("registers", () => {
    const op = getOp("dichroic_mirror", "dichroic_reflect");
    expect(typeof op).toBe("function");
  });

  it("reflect-band λ → full power", () => {
    const op = getOp("dichroic_mirror", "dichroic_reflect");
    const [out] = op(ray(800), ctxReflect());
    expect(out.powerMw).toBeCloseTo(1, 12);
  });

  it("transmit-band λ → blocked from reflect", () => {
    const op = getOp("dichroic_mirror", "dichroic_reflect");
    const [out] = op(ray(650), ctxReflect());
    expect(out.powerMw).toBeCloseTo(0, 12);
  });

  it("direction reflects 90° off B1 at 45°", () => {
    // input (0,0,1), B1 normal (-0.7071,0,0.7071) → reflected (1,0,0).
    const op = getOp("dichroic_mirror", "dichroic_reflect");
    const [out] = op(ray(800), ctxReflect());
    expect(out.direction.x).toBeCloseTo(1, 12);
    expect(out.direction.y).toBeCloseTo(0, 12);
    expect(out.direction.z).toBeCloseTo(0, 12);
  });

  it("throws if transition.via is missing the B1 coating", () => {
    const op = getOp("dichroic_mirror", "dichroic_reflect");
    const r = ray(800);
    const ctx: PhysicsOpContext = {
      faceIn: FACE_A,
      faceOut: FACE_R,
      params: { cutoffWavelengthNm: 700, isShortPass: true },
      faceVia: [],
    };
    expect(() => op(r, ctx)).toThrowError(/via/);
  });
});

describe("dichroic / power conservation transmit + reflect = 1", () => {
  it("at λ=650 (transmit): T+R = 1+0 = 1", () => {
    const tOp = getOp("dichroic_mirror", "dichroic_transmit");
    const rOp = getOp("dichroic_mirror", "dichroic_reflect");
    const r = ray(650);
    const pT = tOp(r, ctxTransmit())[0]!.powerMw;
    const pR = rOp(r, ctxReflect())[0]!.powerMw;
    expect(pT + pR).toBeCloseTo(1, 12);
  });

  it("at λ=800 (reflect): T+R = 0+1 = 1", () => {
    const tOp = getOp("dichroic_mirror", "dichroic_transmit");
    const rOp = getOp("dichroic_mirror", "dichroic_reflect");
    const r = ray(800);
    const pT = tOp(r, ctxTransmit())[0]!.powerMw;
    const pR = rOp(r, ctxReflect())[0]!.powerMw;
    expect(pT + pR).toBeCloseTo(1, 12);
  });

  it("at λ=700 with width=20 (mid-transition): T+R ≈ 1", () => {
    const tOp = getOp("dichroic_mirror", "dichroic_transmit");
    const rOp = getOp("dichroic_mirror", "dichroic_reflect");
    const r = ray(700);
    const pT = tOp(r, ctxTransmit({ transitionWidthNm: 20 }))[0]!.powerMw;
    const pR = rOp(r, ctxReflect({ transitionWidthNm: 20 }))[0]!.powerMw;
    expect(pT + pR).toBeCloseTo(1, 9);
    expect(pT).toBeCloseTo(0.5, 9);
    expect(pR).toBeCloseTo(0.5, 9);
  });
});
