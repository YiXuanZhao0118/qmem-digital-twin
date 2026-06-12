import { describe, it, expect } from "vitest";

import { calculateProfileClipping, gaussianWidthMm } from "../profileUtils";

const lambdaNm = 780;
const lambdaMm = lambdaNm * 1e-6;
// q at a waist of radius w0: q = i·zR, zR = π·w0²/λ ⇒ width(q) === w0.
const qForWaist = (w0Mm: number) => ({ re: 0, im: (Math.PI * w0Mm * w0Mm) / lambdaMm });
const qDummy = { re: 0, im: 1 };

describe("gaussianWidthMm", () => {
  it("recovers the waist radius from its q-parameter", () => {
    expect(gaussianWidthMm(qForWaist(0.5), lambdaMm)).toBeCloseTo(0.5, 6);
    expect(gaussianWidthMm(qForWaist(2), lambdaMm)).toBeCloseTo(2, 6);
  });
  it("returns 0 for a degenerate q (Im ≤ 0)", () => {
    expect(gaussianWidthMm({ re: 1, im: 0 }, lambdaMm)).toBe(0);
  });
});

describe("calculateProfileClipping — ray", () => {
  it("is binary: centre in ⇒ 1, out ⇒ 0", () => {
    expect(calculateProfileClipping(0, 5, { kind: "ray" }, qDummy, qDummy, lambdaNm)).toBe(1);
    expect(calculateProfileClipping(6, 5, { kind: "ray" }, qDummy, qDummy, lambdaNm)).toBe(0);
  });
});

describe("calculateProfileClipping — top_hat", () => {
  it("passes fully when the disc is inside the aperture", () => {
    expect(calculateProfileClipping(0, 5, { kind: "top_hat", radiusMm: 1 }, qDummy, qDummy, lambdaNm)).toBe(1);
  });
  it("blocks fully when the disc is clear of the aperture", () => {
    expect(calculateProfileClipping(10, 5, { kind: "top_hat", radiusMm: 1 }, qDummy, qDummy, lambdaNm)).toBe(0);
  });
  it("centred beam larger than the aperture ⇒ (a/rB)² (the d=0 fix, no NaN)", () => {
    const t = calculateProfileClipping(0, 2, { kind: "top_hat", radiusMm: 4 }, qDummy, qDummy, lambdaNm);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeCloseTo(0.25, 6); // (2/4)²
  });
  it("partial overlap returns a fraction strictly between 0 and 1", () => {
    const t = calculateProfileClipping(2, 2, { kind: "top_hat", radiusMm: 2 }, qDummy, qDummy, lambdaNm);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
  });
});

describe("calculateProfileClipping — gaussian", () => {
  it("small centred beam well inside the aperture ⇒ ≈1", () => {
    const q = qForWaist(0.5);
    expect(calculateProfileClipping(0, 5, { kind: "gaussian" }, q, q, lambdaNm)).toBeCloseTo(1, 6);
  });
  it("centred beam with w = a ⇒ 1 − e⁻²", () => {
    const q = qForWaist(2);
    expect(calculateProfileClipping(0, 2, { kind: "gaussian" }, q, q, lambdaNm)).toBeCloseTo(1 - Math.exp(-2), 4);
  });
  it("centre far beyond the aperture ⇒ 0", () => {
    const q = qForWaist(2);
    expect(calculateProfileClipping(20, 2, { kind: "gaussian" }, q, q, lambdaNm)).toBe(0);
  });
  it("decentred but still contained in a large aperture ⇒ ≈1", () => {
    // Regression: 1 mm beam 8.76 mm off-axis in a 12.7 mm-radius lens is fully
    // contained ⇒ passes. The old exp(−2·rC²/w²) factor wrongly zeroed it.
    const q = qForWaist(0.972);
    expect(
      calculateProfileClipping(8.759, 12.7, { kind: "gaussian" }, q, q, lambdaNm),
    ).toBeCloseTo(1, 5);
  });
  it("centre exactly on the aperture rim ⇒ ½", () => {
    const q = qForWaist(0.5);
    expect(
      calculateProfileClipping(5, 5, { kind: "gaussian" }, q, q, lambdaNm),
    ).toBeCloseTo(0.5, 6);
  });
  it("undefined profile is treated as gaussian", () => {
    const q = qForWaist(0.5);
    expect(calculateProfileClipping(0, 5, undefined, q, q, lambdaNm)).toBeCloseTo(1, 6);
  });
});
