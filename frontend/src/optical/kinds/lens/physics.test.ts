/**
 * Vitest for lens PhysicsOp. Verifies:
 *   1. Op is registered under kind="lens" with name="abcd_thin_lens"
 *   2. Collimated input beam (q at waist far from lens) focuses to a new
 *      waist at distance f behind the lens (qx imag part shows focusing)
 *   3. Chief ray origin advances by thickness from face_in to face_out
 *   4. Polarization (Jones) and power pass through unchanged
 */

import { describe, it, expect } from "vitest";
import "./physics"; // side-effect: registerKind("lens", ...)

import { type BeamRay, makeBeamRay } from "../../beam-ray";
import { type Face, getOp } from "../../registry";

const FACE_IN: Face = {
  id: "A",
  positionMmBodyLocal: { x: 0, y: 0, z: -1.5 },
  apertureMm: 12.7,
  apertureShape: "circle",
};
const FACE_OUT: Face = {
  id: "B",
  positionMmBodyLocal: { x: 0, y: 0, z: +1.5 },
  apertureMm: 12.7,
  apertureShape: "circle",
};

function makeOnAxisRay(): BeamRay {
  return makeBeamRay({
    origin: { x: 0, y: 0, z: -1.5 },        // at face A
    direction: { x: 0, y: 0, z: 1 },        // +z
    wavelengthNm: 780,
    waistRadiusMm: 0.5,
    powerMw: 1.0,
  });
}

describe("lens / abcd_thin_lens", () => {
  it("registers under kind=lens, op=abcd_thin_lens", () => {
    const op = getOp("lens", "abcd_thin_lens");
    expect(typeof op).toBe("function");
  });

  it("throws on missing focal length", () => {
    const op = getOp("lens", "abcd_thin_lens");
    const ray = makeOnAxisRay();
    expect(() =>
      op(ray, { faceIn: FACE_IN, faceOut: FACE_OUT, params: {} }),
    ).toThrowError(/focalLengthMm/);
  });

  it("propagates chief ray from face_in to face_out", () => {
    const op = getOp("lens", "abcd_thin_lens");
    const ray = makeOnAxisRay();
    const [out] = op(ray, {
      faceIn: FACE_IN,
      faceOut: FACE_OUT,
      params: { focalLengthMm: 50 },
    });
    // thickness = 3 mm, ray was at z=-1.5, now at z=+1.5
    expect(out.origin.z).toBeCloseTo(1.5, 9);
    expect(out.pathLengthMm).toBeCloseTo(3.0, 9);
  });

  it("transforms q-parameter (1/q' = 1/q - 1/f)", () => {
    const op = getOp("lens", "abcd_thin_lens");
    // Beam at waist, far enough from lens that real(q) ≈ -large
    const ray = makeOnAxisRay();
    // Shift to before-lens distance
    ray.qx = { re: 0, im: ray.qx.im };       // ensure waist at z=0 of ray's own frame
    ray.qy = { re: 0, im: ray.qy.im };
    const [out] = op(ray, {
      faceIn: FACE_IN,
      faceOut: FACE_OUT,
      params: { focalLengthMm: 50 },
    });
    // Real-axis check: lens introduces negative curvature in 1/q
    // For input q = i·zR, output 1/q' = -i/zR - 1/f
    // → R' = -f (negative = converging) and w stays the same right at the lens
    const f = 50;
    const zR = ray.qx.im; // input Rayleigh range
    // |1/q'|² check via |out.qx|
    // Expected qx_out: q' = q / (1 − q/f) = i·zR / (1 − i·zR/f)
    const denom_re = 1;
    const denom_im = -zR / f;
    const denom_mag2 = denom_re * denom_re + denom_im * denom_im;
    const expected_re = (0 * denom_re + zR * denom_im) / denom_mag2;
    const expected_im = (zR * denom_re - 0 * denom_im) / denom_mag2;
    expect(out.qx.re).toBeCloseTo(expected_re, 6);
    expect(out.qx.im).toBeCloseTo(expected_im, 6);
  });

  it("preserves jones, power, wavelength, direction", () => {
    const op = getOp("lens", "abcd_thin_lens");
    const ray = makeOnAxisRay();
    const [out] = op(ray, {
      faceIn: FACE_IN,
      faceOut: FACE_OUT,
      params: { focalLengthMm: 50 },
    });
    expect(out.jones).toEqual(ray.jones);
    expect(out.powerMw).toBe(ray.powerMw);
    expect(out.wavelengthNm).toBe(ray.wavelengthNm);
    expect(out.direction).toEqual(ray.direction);
  });

  it("returns single ray (no branching)", () => {
    const op = getOp("lens", "abcd_thin_lens");
    const ray = makeOnAxisRay();
    const outs = op(ray, {
      faceIn: FACE_IN,
      faceOut: FACE_OUT,
      params: { focalLengthMm: 50 },
    });
    expect(outs).toHaveLength(1);
  });
});
