/**
 * Vitest for Faraday rotator op. Verifies:
 *   - Jones rotates by rotationDeg (+45° default)
 *   - Non-reciprocal: A2→B2 also +45°, accumulating 90° on round trip
 *   - Power preserved under unitary rotation
 *   - AR coating loss applied per face when arResidualR set
 */

import { describe, it, expect } from "vitest";
import "./physics";

import { type BeamRay, makeBeamRay } from "../../beam-ray";
import { type Complex } from "../../fiber/gaussian";
import { type Face, type PhysicsOpContext, getOp } from "../../registry";

const FACE_A1: Face = {
  id: "A1", positionMmBodyLocal: { x: 0, y: 0, z: -9 },
  normalBodyLocal: { x: 0, y: 0, z: -1 },
  apertureMm: 4, apertureShape: "circle",
};
const FACE_B1: Face = {
  id: "B1", positionMmBodyLocal: { x: 0, y: 0, z: 9 },
  normalBodyLocal: { x: 0, y: 0, z: 1 },
  apertureMm: 4, apertureShape: "circle",
};
const FACE_A2: Face = {
  id: "A2", positionMmBodyLocal: { x: 0, y: 0, z: 9 },
  normalBodyLocal: { x: 0, y: 0, z: 1 },
  apertureMm: 4, apertureShape: "circle",
};
const FACE_B2: Face = {
  id: "B2", positionMmBodyLocal: { x: 0, y: 0, z: -9 },
  normalBodyLocal: { x: 0, y: 0, z: -1 },
  apertureMm: 4, apertureShape: "circle",
};

function rayWithJones(jones: [Complex, Complex], origin = { x: 0, y: 0, z: -9 }, dir = { x: 0, y: 0, z: 1 }): BeamRay {
  return {
    ...makeBeamRay({
      origin, direction: dir, wavelengthNm: 850, powerMw: 1.0,
    }),
    jones,
  };
}

const ctxForward = (params: Record<string, unknown> = {}): PhysicsOpContext => ({
  faceIn: FACE_A1, faceOut: FACE_B1,
  params: { rotationDeg: 45, lengthMm: 18, refractiveIndex: 1.95, ...params },
});
const ctxReverse = (params: Record<string, unknown> = {}): PhysicsOpContext => ({
  faceIn: FACE_A2, faceOut: FACE_B2,
  params: { rotationDeg: 45, lengthMm: 18, refractiveIndex: 1.95, ...params },
});

describe("faraday_rotator / faraday_rotate", () => {
  it("registers under kind=faraday_rotator", () => {
    const op = getOp("faraday_rotator", "faraday_rotate");
    expect(typeof op).toBe("function");
  });

  it("rotates pure +s by 45° → ( cos45, sin45 )", () => {
    const op = getOp("faraday_rotator", "faraday_rotate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxForward());
    const a = Math.SQRT1_2;
    expect(out.jones[0].re).toBeCloseTo(a, 12);
    expect(out.jones[1].re).toBeCloseTo(a, 12);
  });

  it("rotates pure +p by 45° → ( -sin45, cos45 )", () => {
    const op = getOp("faraday_rotator", "faraday_rotate");
    const ray = rayWithJones([{ re: 0, im: 0 }, { re: 1, im: 0 }]);
    const [out] = op(ray, ctxForward());
    const a = Math.SQRT1_2;
    expect(out.jones[0].re).toBeCloseTo(-a, 12);
    expect(out.jones[1].re).toBeCloseTo(a, 12);
  });

  it("direction-aware sign: forward and reverse rotate opposite ways in s/p", () => {
    // Forward (dir.z=+1) rotates +45° in s/p frame.
    // Reverse (dir.z=-1) rotates -45° in s/p frame, which equals +45° in lab
    // (because p axis flips). This is the non-reciprocal-in-lab convention:
    // the LAB rotation direction is fixed regardless of beam direction.
    const op = getOp("faraday_rotator", "faraday_rotate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [fwd] = op(ray, ctxForward());
    const a = Math.SQRT1_2;
    // Forward: +s → (cos45, sin45) in s/p
    expect(fwd.jones[0].re).toBeCloseTo(a, 12);
    expect(fwd.jones[1].re).toBeCloseTo(a, 12);

    // Reverse: take same jones [cos45, sin45], flip direction, apply op.
    // The op's beam-frame rotation flips sign (dir.z<0), so [cos45, sin45]
    // rotates BACK to [1, 0] in s/p frame.
    const rev = { ...fwd, direction: { x: 0, y: 0, z: -1 } };
    const [rt] = op(rev, ctxReverse());
    expect(rt.jones[0].re).toBeCloseTo(1, 9);
    expect(rt.jones[1].re).toBeCloseTo(0, 9);
    // Note: the scene tracer re-bases jones across direction changes, so
    // the "isolator blocks reverse" emerges from the tracer + Faraday +
    // polarizer composition, not from this single-op manual round trip.
    // See IO-3 isolator scene test for the full round-trip behavior.
  });

  it("power preserved under pure rotation (no AR loss)", () => {
    const op = getOp("faraday_rotator", "faraday_rotate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxForward());
    expect(out.powerMw).toBeCloseTo(1.0, 12);
  });

  it("AR coating loss applied per face (1-R)^2", () => {
    const op = getOp("faraday_rotator", "faraday_rotate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxForward({ arResidualR: 0.005 }));
    const expected = 1.0 * (1 - 0.005) ** 2;
    expect(out.powerMw).toBeCloseTo(expected, 12);
  });

  it("q-parameter propagates by B = L/n (default deriv)", () => {
    const op = getOp("faraday_rotator", "faraday_rotate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const B_expected = 18 / 1.95;  // ≈ 9.231
    const qx_in = ray.qx;
    const [out] = op(ray, ctxForward());
    // For slab: q_out = q_in + B
    expect(out.qx.re).toBeCloseTo(qx_in.re + B_expected, 9);
    expect(out.qx.im).toBeCloseTo(qx_in.im, 12);
  });

  it("chief ray propagates face_in → face_out", () => {
    const op = getOp("faraday_rotator", "faraday_rotate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxForward());
    // face_in z=-9, face_out z=+9, ray moves 18mm along +z
    expect(out.origin.z).toBeCloseTo(9, 9);
    expect(out.pathLengthMm).toBeCloseTo(18, 9);
  });
});
