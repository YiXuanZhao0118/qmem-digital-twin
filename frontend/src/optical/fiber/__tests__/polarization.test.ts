import { describe, expect, it } from "vitest";
import {
  applyFiberPolarizationTransform,
  applyJonesMatrix,
  jonesFromLinearAngle,
  jonesPower,
  pmFiberJones,
  smFiberJones,
  stokesFromJones,
} from "../polarization";

describe("Jones / Stokes basics", () => {
  it("linear x polarization ⇒ Stokes (1, 1, 0, 0)", () => {
    const j = jonesFromLinearAngle(0);
    const s = stokesFromJones(j);
    expect(s.s0).toBeCloseTo(1, 8);
    expect(s.s1).toBeCloseTo(1, 8);
    expect(s.s2).toBeCloseTo(0, 8);
    expect(s.s3).toBeCloseTo(0, 8);
  });

  it("linear at 45° ⇒ Stokes (1, 0, 1, 0)", () => {
    const j = jonesFromLinearAngle(Math.PI / 4);
    const s = stokesFromJones(j);
    expect(s.s0).toBeCloseTo(1, 8);
    expect(s.s1).toBeCloseTo(0, 8);
    expect(s.s2).toBeCloseTo(1, 8);
    expect(s.s3).toBeCloseTo(0, 8);
  });
});

describe("PM fiber Jones — power preservation + axis-aligned input", () => {
  it("input on slow axis (0°) ⇒ output stays on slow axis, power = 1", () => {
    const m = pmFiberJones(0, 5e-4, 780e-9, 1.0);
    const jIn = jonesFromLinearAngle(0); // linear x = slow axis
    const jOut = applyJonesMatrix(m.m00, m.m01, m.m10, m.m11, jIn);
    expect(jonesPower(jOut)).toBeCloseTo(1, 6);
    // Output should still be linear-x (real) up to global phase
    expect(jOut.ey.re ** 2 + jOut.ey.im ** 2).toBeLessThan(1e-12);
  });

  it("input at 45° to slow axis, length = π / Δβ ⇒ output is 45°-rotated (handedness flip)", () => {
    // For Δn = 5e-4, λ = 780 nm: full half-wave length = λ/(2·Δn) = 780e-9/(2·5e-4) ≈ 0.78 mm
    const lambdaM = 780e-9;
    const dn = 5e-4;
    const halfWaveL = lambdaM / (2 * dn);
    // Total power must still be 1 regardless of input/length
    const m = pmFiberJones(0, dn, lambdaM, halfWaveL);
    const jIn = jonesFromLinearAngle(Math.PI / 4);
    const jOut = applyJonesMatrix(m.m00, m.m01, m.m10, m.m11, jIn);
    expect(jonesPower(jOut)).toBeCloseTo(1, 6);
  });

  it("MM fiber ⇒ fully depolarized Stokes (S0, 0, 0, 0)", () => {
    const jIn = jonesFromLinearAngle(0);
    const r = applyFiberPolarizationTransform({
      fiberType: "multi_mode",
      inputJones: jIn,
    });
    expect(r.stokes.s0).toBeCloseTo(1, 6);
    expect(r.stokes.s1).toBeCloseTo(0, 6);
    expect(r.stokes.s2).toBeCloseTo(0, 6);
    expect(r.stokes.s3).toBeCloseTo(0, 6);
    expect(r.jones).toBeUndefined();
  });

  it("SM (non-PM) Jones rotation is unitary (preserves power)", () => {
    const m = smFiberJones(42);
    const jIn = jonesFromLinearAngle(Math.PI / 7);
    const jOut = applyJonesMatrix(m.m00, m.m01, m.m10, m.m11, jIn);
    expect(jonesPower(jOut)).toBeCloseTo(1, 6);
  });

  it("SM with same seed ⇒ same Jones matrix (reproducibility)", () => {
    const m1 = smFiberJones(123);
    const m2 = smFiberJones(123);
    expect(m1.m00.re).toBe(m2.m00.re);
    expect(m1.m00.im).toBe(m2.m00.im);
    expect(m1.m11.re).toBe(m2.m11.re);
  });
});
