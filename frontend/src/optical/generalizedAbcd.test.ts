import { describe, expect, it } from "vitest";

import {
  type BeamMisaligned,
  applyOperator,
  beamMisaligned,
  compose,
  mat5Identity,
  mat5Mul,
  mCurvedMirror,
  mCylindricalRotated,
  mCylindricalStandard,
  mFlatMirror,
  mFreeSpace,
  mGlassPlate,
  mPbsReflected,
  mPbsTransmitted,
  mRotation,
  mThinLens,
  qFromWaist,
  radiusOfCurvatureMm,
  spotRadiusUm,
  waistUmFromQ,
} from "./generalizedAbcd";

const WAVELENGTH_NM = 780.241;

function near(a: number, b: number, atol = 1e-9): boolean {
  return Math.abs(a - b) < atol;
}

// --------- operator matrix structure ---------

describe("5×5 operator structure", () => {
  it("free space sets B elements only", () => {
    const M = mFreeSpace(123);
    expect(M[0 * 5 + 1]).toBe(123);
    expect(M[2 * 5 + 3]).toBe(123);
  });

  it("thin lens centered: pure focusing per spec", () => {
    const f = 100;
    const M = mThinLens(f);
    expect(M[1 * 5 + 0]).toBeCloseTo(-1 / f);
    expect(M[3 * 5 + 2]).toBeCloseTo(-1 / f);
    expect(M[1 * 5 + 4]).toBe(0);
    expect(M[3 * 5 + 4]).toBe(0);
  });

  it("thin lens decenter+tilt: literal δ/f + α(1−1/f)", () => {
    const f = 100, dx = 0.5, dy = -0.3, ax = 0.001, ay = 0.002;
    const M = mThinLens(f, { deltaXMm: dx, deltaYMm: dy, alphaXRad: ax, alphaYRad: ay });
    const invF = 1 / f;
    expect(M[1 * 5 + 4]).toBeCloseTo(dx * invF + ay * (1 - invF));
    expect(M[3 * 5 + 4]).toBeCloseTo(dy * invF + ax * (1 - invF));
  });

  it("cylindrical x-axis: focus in x + glass plate in y", () => {
    const f = 50, d = 5, n = 1.515;
    const M = mCylindricalStandard(f, { axis: "x", thicknessMm: d, refractiveIndex: n, alphaXRad: 0.01 });
    expect(M[1 * 5 + 0]).toBeCloseTo(-1 / f);
    expect(M[2 * 5 + 3]).toBeCloseTo(d / n);
    expect(M[2 * 5 + 4]).toBeCloseTo(0.01 * d * (1 - 1 / n));
  });

  it("cylindrical y-axis: swaps focus and plate blocks", () => {
    const f = 50, d = 5, n = 1.515;
    const M = mCylindricalStandard(f, { axis: "y", thicknessMm: d, refractiveIndex: n });
    expect(M[0 * 5 + 1]).toBeCloseTo(d / n);
    expect(M[3 * 5 + 2]).toBeCloseTo(-1 / f);
  });

  it("flat mirror has no decenter term (per spec)", () => {
    const M = mFlatMirror({ alphaXRad: 0.003, alphaYRad: 0.004 });
    expect(M[1 * 5 + 1]).toBe(-1);
    expect(M[3 * 5 + 3]).toBe(-1);
    expect(M[1 * 5 + 4]).toBeCloseTo(2 * 0.004);
    expect(M[3 * 5 + 4]).toBeCloseTo(2 * 0.003);
  });

  it("curved mirror: f = R/2 + reflection", () => {
    const R = 200;
    const M = mCurvedMirror(R, { deltaXMm: 0.1, alphaYRad: 0.005 });
    const invF = 2 / R;
    expect(M[1 * 5 + 0]).toBeCloseTo(-invF);
    expect(M[1 * 5 + 1]).toBe(-1);
    expect(M[1 * 5 + 4]).toBeCloseTo(0.1 * invF + 2 * 0.005);
  });

  it("PBS reflected ≡ flat mirror", () => {
    const t = { alphaXRad: 0.003, alphaYRad: 0.004 };
    expect(mPbsReflected(t)).toEqual(mFlatMirror(t));
  });

  it("PBS transmitted ≡ glass plate of cube edge length", () => {
    expect(mPbsTransmitted(12.7, 1.515, { alphaXRad: 0.001 }))
      .toEqual(mGlassPlate(12.7, 1.515, { alphaXRad: 0.001 }));
  });

  it("glass plate: d/n + α·d(1−1/n)", () => {
    const d = 10, n = 1.5;
    const M = mGlassPlate(d, n, { alphaXRad: 0.001, alphaYRad: 0.002 });
    expect(M[0 * 5 + 1]).toBeCloseTo(d / n);
    expect(M[0 * 5 + 4]).toBeCloseTo(0.002 * d * (1 - 1 / n));
    expect(M[2 * 5 + 4]).toBeCloseTo(0.001 * d * (1 - 1 / n));
  });

  it("rotation matrix is orthogonal", () => {
    const product = mat5Mul(mRotation(0.37), mRotation(-0.37));
    const I = mat5Identity();
    for (let i = 0; i < 25; i++) expect(product[i]).toBeCloseTo(I[i]);
  });

  it("cylindrical rotated by π/2 swaps focusing axis", () => {
    const M = mCylindricalRotated(50, Math.PI / 2, { axis: "x" });
    expect(Math.abs(M[1 * 5 + 0])).toBeLessThan(1e-12);
    expect(M[3 * 5 + 2]).toBeCloseTo(-1 / 50);
  });

  it("compose is right-to-left", () => {
    const A = mThinLens(100);
    const B = mFreeSpace(50);
    expect(compose(A, B)).toEqual(mat5Mul(B, A));
  });
});

// --------- q-parameter constructors ---------

describe("q-parameter helpers", () => {
  it("q at waist is pure imaginary", () => {
    const q = qFromWaist(100, 0, WAVELENGTH_NM);
    expect(q.re).toBeCloseTo(0);
    expect(q.im).toBeGreaterThan(0);
  });

  it("waist roundtrip", () => {
    const q = qFromWaist(150, 0, WAVELENGTH_NM);
    expect(waistUmFromQ(q, WAVELENGTH_NM)).toBeCloseTo(150);
  });

  it("spot at waist equals waist radius", () => {
    const q = qFromWaist(100, 0, WAVELENGTH_NM);
    expect(spotRadiusUm(q, WAVELENGTH_NM)).toBeCloseTo(100);
  });

  it("spot grows far from waist", () => {
    const q = qFromWaist(100, 0, WAVELENGTH_NM);
    const qFar = { re: q.re + 1000, im: q.im };
    expect(spotRadiusUm(qFar, WAVELENGTH_NM)).toBeGreaterThan(100);
  });

  it("radius at waist is +∞", () => {
    const q = qFromWaist(100, 0, WAVELENGTH_NM);
    expect(radiusOfCurvatureMm(q)).toBe(Number.POSITIVE_INFINITY);
  });
});

// --------- apply_operator: q-ABCD ---------

describe("applyOperator — q-ABCD law", () => {
  it("free space advances q.re", () => {
    const q0 = qFromWaist(100, 0, WAVELENGTH_NM);
    const beam = beamMisaligned({ qX: q0, qY: q0, wavelengthNm: WAVELENGTH_NM });
    const out = applyOperator(beam, mFreeSpace(200));
    expect(out.qX.re).toBeCloseTo(q0.re + 200);
    expect(out.qX.im).toBeCloseTo(q0.im);
  });

  it("thin lens focuses collimated beam to ~f", () => {
    const f = 100;
    const qIn = qFromWaist(1000, 0, WAVELENGTH_NM); // 1mm collimated waist at lens
    const beam = beamMisaligned({ qX: qIn, qY: qIn, wavelengthNm: WAVELENGTH_NM });
    const out = applyOperator(beam, mThinLens(f));
    expect(-out.qX.re).toBeCloseTo(f, 0);
  });

  it("flat mirror inverts q", () => {
    const q0 = { re: 50, im: 30 };
    const beam = beamMisaligned({ qX: q0, qY: q0, wavelengthNm: WAVELENGTH_NM });
    const out = applyOperator(beam, mFlatMirror());
    expect(out.qX.re).toBeCloseTo(-q0.re);
    expect(out.qX.im).toBeCloseTo(-q0.im);
  });

  it("glass plate adds d/n to q.re", () => {
    const q0 = qFromWaist(500, 0, WAVELENGTH_NM);
    const beam = beamMisaligned({ qX: q0, qY: q0, wavelengthNm: WAVELENGTH_NM });
    const d = 10, n = 1.5;
    const out = applyOperator(beam, mGlassPlate(d, n));
    expect(out.qX.re).toBeCloseTo(q0.re + d / n);
  });
});

// --------- apply_operator: chief-ray ---------

describe("applyOperator — chief-ray", () => {
  let beam: BeamMisaligned;
  const q0 = qFromWaist(500, 0, WAVELENGTH_NM);

  it("free space carries tilted off-axis beam by L·θ", () => {
    beam = beamMisaligned({ qX: q0, qY: q0, xCMm: 0.5, thetaXCRad: 0.01, wavelengthNm: WAVELENGTH_NM });
    const out = applyOperator(beam, mFreeSpace(100));
    expect(out.xCMm).toBeCloseTo(0.5 + 100 * 0.01);
    expect(out.thetaXCRad).toBeCloseTo(0.01);
  });

  it("decentered lens kicks on-axis beam by δ/f", () => {
    beam = beamMisaligned({ qX: q0, qY: q0, wavelengthNm: WAVELENGTH_NM });
    const out = applyOperator(beam, mThinLens(100, { deltaXMm: 0.5 }));
    expect(out.thetaXCRad).toBeCloseTo(0.5 / 100);
  });

  it("glass plate shifts tilted beam by (d/n)·θ", () => {
    beam = beamMisaligned({ qX: q0, qY: q0, thetaXCRad: 0.01, wavelengthNm: WAVELENGTH_NM });
    const d = 10, n = 1.5;
    const out = applyOperator(beam, mGlassPlate(d, n));
    expect(out.xCMm).toBeCloseTo((d / n) * 0.01);
    expect(out.thetaXCRad).toBeCloseTo(0.01);
  });

  it("tilted mirror deflects by 2α", () => {
    beam = beamMisaligned({ qX: q0, qY: q0, wavelengthNm: WAVELENGTH_NM });
    const out = applyOperator(beam, mFlatMirror({ alphaYRad: 0.005 }));
    expect(out.thetaXCRad).toBeCloseTo(2 * 0.005);
  });

  it("compose ≡ sequential application", () => {
    beam = beamMisaligned({ qX: q0, qY: q0, xCMm: 0.2, thetaXCRad: 0.005, wavelengthNm: WAVELENGTH_NM });
    const lens = mThinLens(150, { deltaXMm: 0.1 });
    const space = mFreeSpace(80);
    const seq = applyOperator(applyOperator(beam, lens), space);
    const once = applyOperator(beam, compose(lens, space));
    expect(near(seq.xCMm, once.xCMm)).toBe(true);
    expect(near(seq.thetaXCRad, once.thetaXCRad)).toBe(true);
    expect(near(seq.qX.re, once.qX.re)).toBe(true);
    expect(near(seq.qX.im, once.qX.im)).toBe(true);
  });

  it("rotated cylindrical lens couples x and y chief-ray", () => {
    beam = beamMisaligned({ qX: q0, qY: q0, xCMm: 1.0, wavelengthNm: WAVELENGTH_NM });
    const out = applyOperator(beam, mCylindricalRotated(100, Math.PI / 4, { axis: "x" }));
    expect(Math.abs(out.thetaXCRad)).toBeGreaterThan(1e-9);
    expect(Math.abs(out.thetaYCRad)).toBeGreaterThan(1e-9);
  });
});
