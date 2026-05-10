import { describe, expect, it } from "vitest";
import {
  arcLengthOfCurve,
  curvatureRadiusAt,
  cubicBezierDerivative,
} from "../arc_length";

describe("Arc length & curvature", () => {
  it("straight line: r(t) = t·(L, 0, 0) ⇒ arc length = L", () => {
    const L = 100;
    const speed = (_t: number) => L; // |r'(t)| = |(L, 0, 0)| = L for all t
    expect(arcLengthOfCurve(speed)).toBeCloseTo(L, 8);
  });

  it("semicircle (radius R): arc length = πR", () => {
    const R = 10;
    // r(t) = (R cos πt, R sin πt, 0), t ∈ [0, 1]
    // r'(t) = (-Rπ sin πt, Rπ cos πt, 0); |r'| = Rπ
    const speed = (_t: number) => R * Math.PI;
    expect(arcLengthOfCurve(speed)).toBeCloseTo(R * Math.PI, 6);
  });

  it("cubic bezier derivative — known endpoints", () => {
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [1, 0, 0];
    const p2: [number, number, number] = [2, 0, 0];
    const p3: [number, number, number] = [3, 0, 0];
    // Straight line, so derivative = 3·(P1-P0) at t=0 = (3, 0, 0)
    const d0 = cubicBezierDerivative(0, p0, p1, p2, p3);
    expect(d0[0]).toBeCloseTo(3, 8);
    // Same at t=1: 3·(P3-P2) = (3, 0, 0)
    const d1 = cubicBezierDerivative(1, p0, p1, p2, p3);
    expect(d1[0]).toBeCloseTo(3, 8);
  });

  it("curvature radius of straight segment ⇒ +∞", () => {
    const r = curvatureRadiusAt([1, 0, 0], [0, 0, 0]);
    expect(r).toBe(Number.POSITIVE_INFINITY);
  });

  it("curvature radius for unit circle in xy: R = 1", () => {
    // r(θ) = (cos θ, sin θ, 0); r' = (-sin θ, cos θ, 0); r'' = (-cos θ, -sin θ, 0)
    // |r'|³ = 1, |r' × r''| = 1 ⇒ R = 1
    const rPrime: [number, number, number] = [-Math.sin(0.5), Math.cos(0.5), 0];
    const rDDot: [number, number, number] = [-Math.cos(0.5), -Math.sin(0.5), 0];
    const R = curvatureRadiusAt(rPrime, rDDot);
    expect(R).toBeCloseTo(1, 6);
  });
});
