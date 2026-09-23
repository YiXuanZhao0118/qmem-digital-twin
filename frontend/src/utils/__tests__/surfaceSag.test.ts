import { describe, expect, it } from "vitest";

import { surfaceSagMm } from "../surfaceSag";

describe("surfaceSagMm", () => {
  it("puts the LA1509-B convex rim where the mesh has it", () => {
    // docs/surface-optics.md: vertex z = 3.59, R = −51.5, aperture r = 12.7,
    // rim top at z = 1.9995 (the 2.0 mm edge).
    const w = surfaceSagMm({ type: "sphere", radiusMm: -51.5 }, 12.7, 0)!;
    expect(3.59 + w).toBeCloseTo(1.9995, 3);
  });

  it("curves toward +axisX for R > 0 and is symmetric about the axis", () => {
    const shape = { type: "sphere" as const, radiusMm: 20 };
    expect(surfaceSagMm(shape, 3, 4)).toBeGreaterThan(0);
    expect(surfaceSagMm(shape, 3, 4)).toBeCloseTo(surfaceSagMm(shape, 0, 5)!, 12);
  });

  it("is zero for a plane and null past a sphere's rim", () => {
    expect(surfaceSagMm({ type: "plane" }, 7, -3)).toBe(0);
    expect(surfaceSagMm({ type: "sphere", radiusMm: 10 }, 11, 0)).toBeNull();
  });

  it("curves a cylinder along u (axisY) only", () => {
    const shape = { type: "cylinder" as const, radiusMm: 25 };
    expect(surfaceSagMm(shape, 0, 8)).toBe(0);
    expect(surfaceSagMm(shape, 8, 0)).toBeCloseTo(
      surfaceSagMm({ type: "sphere", radiusMm: 25 }, 8, 0)!,
      12,
    );
  });

  it("reduces a k = 0 conic to the sphere and adds the asphere terms", () => {
    const sphere = surfaceSagMm({ type: "sphere", radiusMm: -30 }, 4, 2)!;
    expect(surfaceSagMm({ type: "conic", radiusMm: -30, conic: 0 }, 4, 2)).toBeCloseTo(sphere, 12);
    const r2 = 4 * 4 + 2 * 2;
    expect(
      surfaceSagMm({ type: "conic", radiusMm: -30, conic: 0, asphericCoeffs: [1e-5, 2e-8] }, 4, 2),
    ).toBeCloseTo(sphere + 1e-5 * r2 ** 2 + 2e-8 * r2 ** 3, 12);
  });
});
