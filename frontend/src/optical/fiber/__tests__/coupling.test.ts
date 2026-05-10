/**
 * Textbook validation suite for fiber coupling physics.
 *
 * Each test pins a closed-form result we can verify by hand against a
 * standard reference (Marcuse 1977, Saleh-Teich, Hecht, Born-Wolf).
 * Failure here means the physics core has drifted — DO NOT just
 * relax the tolerance.
 */

import { describe, expect, it } from "vitest";
import { computeCouplingEfficiency, type FiberFaceSpec } from "../coupling";

const lambda = 780e-9; // 780 nm
const wF = 5.3e-6 / 2; // MFD/2 for typical PM SMF at 780 nm

const baseFace = (overrides: Partial<FiberFaceSpec> = {}): FiberFaceSpec => ({
  fiberType: "single_mode",
  modeFieldRadiusM: wF,
  apertureRadiusM: 62.5e-6, // cladding 125 µm
  numericalAperture: 0.13,
  lateralOffsetM: [0, 0],
  angularMisalignmentRad: 0,
  ...overrides,
});

describe("Marcuse circular Gaussian → LP01", () => {
  it("perfect mode match (w_b = w_f, no offset, no tilt) ⇒ η = 1", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "gaussian_circular",
        waistRadiusAtFaceM: wF,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBeCloseTo(1.0, 5);
  });

  it("waist 2× fiber mode ⇒ η = (2·2·1/(4+1))² = 0.64", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "gaussian_circular",
        waistRadiusAtFaceM: 2 * wF,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBeCloseTo(0.64, 4);
  });

  it("waist 1/2 fiber mode ⇒ η = (2·0.5·1/(0.25+1))² = 0.64 (symmetric)", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "gaussian_circular",
        waistRadiusAtFaceM: 0.5 * wF,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBeCloseTo(0.64, 4);
  });

  it("lateral offset Δr = w_f (and w_b = w_f) ⇒ η = exp(−1) ≈ 0.368", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "gaussian_circular",
        waistRadiusAtFaceM: wF,
        lambdaM: lambda,
      },
      baseFace({ lateralOffsetM: [wF, 0] }),
    );
    expect(r.etaCoupling).toBeCloseTo(Math.exp(-1), 4);
  });

  it("angular tilt α = λ/(π·w_f) (and w_b = w_f) ⇒ η = exp(−π²/2)·1 ≈ 0.00721 — far field zero", () => {
    // Tilt α makes the angular factor exp(-2·(π·w_b·w_f/λ)² · α² / (w_b² + w_f²))
    // With w_b = w_f, this simplifies: exp(-π² (w_f²/λ)² · α²·2 / (2·w_f²))
    //                                 = exp(-(π² · w_f²/λ²) · α²)
    // For α = λ/(π·w_f):  exp(-(π² · w_f²/λ²) · λ²/(π² w_f²))
    //                   = exp(-1)  ≈ 0.368
    const alpha = lambda / (Math.PI * wF);
    const r = computeCouplingEfficiency(
      {
        kind: "gaussian_circular",
        waistRadiusAtFaceM: wF,
        lambdaM: lambda,
      },
      baseFace({ angularMisalignmentRad: alpha }),
    );
    expect(r.etaCoupling).toBeCloseTo(Math.exp(-1), 3);
  });
});

describe("Astigmatic Gaussian → LP01", () => {
  it("symmetric (w_x = w_y = w_f) reduces to circular Marcuse = 1", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "gaussian_astigmatic",
        waistRadiusXAtFaceM: wF,
        waistRadiusYAtFaceM: wF,
        axisRotationRad: 0,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBeCloseTo(1.0, 5);
  });

  it("w_x = 2 w_f, w_y = w_f ⇒ η = (2·2·1/(4+1) · 2·1·1/(1+1))² = (0.8·1)² = 0.64", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "gaussian_astigmatic",
        waistRadiusXAtFaceM: 2 * wF,
        waistRadiusYAtFaceM: wF,
        axisRotationRad: 0,
        lambdaM: lambda,
      },
      baseFace(),
    );
    // 2D power overlap = (amp_x · amp_y)²
    // amp_x = 2·2·1/(4+1) = 0.8;  amp_y = 1.0
    // η = (0.8 · 1.0)² = 0.64
    expect(r.etaCoupling).toBeCloseTo(0.64, 4);
  });
});

describe("Hermite-Gauss TEM_mn → LP01 — parity & closed form", () => {
  it("HG_01 ⇒ η = 0 (n odd)", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "hermite_gauss",
        m: 0,
        n: 1,
        waistRadiusXAtFaceM: wF,
        waistRadiusYAtFaceM: wF,
        axisRotationRad: 0,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBe(0);
    expect(r.etaCouplingComponents?.parityZero).toBe(true);
  });

  it("HG_10 ⇒ η = 0 (m odd)", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "hermite_gauss",
        m: 1,
        n: 0,
        waistRadiusXAtFaceM: wF,
        waistRadiusYAtFaceM: wF,
        axisRotationRad: 0,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBe(0);
  });

  it("HG_11 ⇒ η = 0 (both odd)", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "hermite_gauss",
        m: 1,
        n: 1,
        waistRadiusXAtFaceM: wF,
        waistRadiusYAtFaceM: wF,
        axisRotationRad: 0,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBe(0);
  });

  it("HG_00 with w_b = w_f reduces to circular Marcuse = 1", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "hermite_gauss",
        m: 0,
        n: 0,
        waistRadiusXAtFaceM: wF,
        waistRadiusYAtFaceM: wF,
        axisRotationRad: 0,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBeCloseTo(1.0, 5);
  });

  it("HG_20 with w_b = w_f ⇒ η = 0 (factor (w_f²−w_b²)^m vanishes)", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "hermite_gauss",
        m: 2,
        n: 0,
        waistRadiusXAtFaceM: wF,
        waistRadiusYAtFaceM: wF,
        axisRotationRad: 0,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBeCloseTo(0, 6);
  });
});

describe("Laguerre-Gauss LG_pl → LP01 — OAM orthogonality", () => {
  it("LG_01 (l=1 vortex) ⇒ η = 0 (OAM orthogonal to LP01)", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "laguerre_gauss",
        p: 0,
        l: 1,
        waistRadiusAtFaceM: wF,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBe(0);
    expect(r.etaCouplingComponents?.parityZero).toBe(true);
  });

  it("LG_02 (l=2) ⇒ η = 0", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "laguerre_gauss",
        p: 0,
        l: 2,
        waistRadiusAtFaceM: wF,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBe(0);
  });

  it("LG_00 = TEM_00, w_b = w_f ⇒ η = 1", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "laguerre_gauss",
        p: 0,
        l: 0,
        waistRadiusAtFaceM: wF,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBeCloseTo(1.0, 5);
  });

  it("LG_10 (radial p=1, l=0) with w_b = w_f ⇒ η = 0 (orthogonal)", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "laguerre_gauss",
        p: 1,
        l: 0,
        waistRadiusAtFaceM: wF,
        lambdaM: lambda,
      },
      baseFace(),
    );
    expect(r.etaCoupling).toBeCloseTo(0, 6);
  });
});

describe("Flat-top → LP01", () => {
  it("R = w_f ⇒ η = 2·(1−exp(−1))²·w_f²/R² = 2·0.6321² ≈ 0.7993", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "flat_top",
        topHatRadiusM: wF,
        lambdaM: lambda,
      },
      baseFace(),
    );
    const expected = 2 * Math.pow(1 - Math.exp(-1), 2);
    expect(r.etaCoupling).toBeCloseTo(expected, 4);
  });

  it("R → 0 (point source) ⇒ η → 2·R²/w_f² (small-R limit)", () => {
    const Rsmall = 0.05 * wF;
    const r = computeCouplingEfficiency(
      {
        kind: "flat_top",
        topHatRadiusM: Rsmall,
        lambdaM: lambda,
      },
      baseFace(),
    );
    // η ≈ (2 w_f²/R²) · (R²/w_f²)² = 2 R²/w_f²  (leading order)
    const expected = (2 * Rsmall * Rsmall) / (wF * wF);
    expect(r.etaCoupling).toBeCloseTo(expected, 3);
  });
});

describe("Multi-mode coupling", () => {
  const mmFace = (overrides: Partial<FiberFaceSpec> = {}): FiberFaceSpec => ({
    fiberType: "multi_mode",
    modeFieldRadiusM: null,
    apertureRadiusM: 25e-6, // 50 µm core
    numericalAperture: 0.22,
    lateralOffsetM: [0, 0],
    angularMisalignmentRad: 0,
    ...overrides,
  });

  it("Gaussian beam much smaller than core, paraxial ⇒ η → 1", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "gaussian_circular",
        waistRadiusAtFaceM: 5e-6,
        lambdaM: lambda,
      },
      mmFace(),
    );
    expect(r.etaCoupling).toBeGreaterThan(0.95);
  });

  it("flat-top R = 1.5 × core radius ⇒ η_spatial = (R_apt/R_top)² ≈ 0.444", () => {
    const r = computeCouplingEfficiency(
      {
        kind: "flat_top",
        topHatRadiusM: 1.5 * 25e-6,
        lambdaM: lambda,
      },
      mmFace(),
    );
    // η_spatial = (1/1.5)² = 0.444; η_angular ≈ 1 for flat-top in this case
    expect(r.etaCouplingComponents?.spatialOverlap).toBeCloseTo(1 / 2.25, 3);
  });
});
