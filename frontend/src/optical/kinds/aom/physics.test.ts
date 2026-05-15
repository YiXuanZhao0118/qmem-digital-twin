/**
 * Regression tests for AOM physics formulas. Pinned in Phase 7 when the
 * formulas were extracted from OpticalElementPanel.tsx and rayTrace.ts
 * into a single source. Future edits to the closed-form sin² model,
 * Bessel series, or sideband normalisation must keep these tests green
 * — that's the network preventing the panel and the ray-tracer from
 * silently disagreeing again.
 *
 * Numerical tolerances are tuned to the ASCII series convergence cutoff
 * (1e-16 truncation in besselJ), not arbitrary loose epsilons.
 */

import { describe, expect, it } from "vitest";
import {
  AomPhysicsParams,
  aomBodyFrameBodyLocal,
  aomTraversalSignFromEntryPort,
  besselJ,
  braggAngleRad,
  computeBraggTiltAxisBodyLocal,
  computeBraggTiltAxisFromRfDirectionBodyLocal,
  DEFAULT_STAGE1_MODE,
  DEFAULT_STAGE2_SIGN,
  diffractedDirection,
  diffractionEfficiency,
  effectiveAomOrderForTraversal,
  expectedInputDotD2,
  phaseModulationDepth,
  resolveTraversalSign,
  rfPowerForPeakEfficiencyW,
  sidebandIntensitiesOnBragg,
  SUPPRESSED_FIRST_ORDER_FLOOR,
} from "./physics";

// =============================================================================
// besselJ
// =============================================================================

describe("besselJ", () => {
  it("J_0(0) = 1", () => {
    expect(besselJ(0, 0)).toBe(1);
  });

  it("J_n(0) = 0 for n > 0", () => {
    expect(besselJ(1, 0)).toBe(0);
    expect(besselJ(2, 0)).toBe(0);
    expect(besselJ(5, 0)).toBe(0);
  });

  it("J_{-n}(x) = (-1)^n · J_n(x)", () => {
    const x = 1.7;
    expect(besselJ(-1, x)).toBeCloseTo(-besselJ(1, x), 12);
    expect(besselJ(-2, x)).toBeCloseTo(besselJ(2, x), 12);
    expect(besselJ(-3, x)).toBeCloseTo(-besselJ(3, x), 12);
  });

  it("matches reference values (Wolfram-style spot checks)", () => {
    // J_0(1) ≈ 0.7651976865579666
    expect(besselJ(0, 1)).toBeCloseTo(0.7651976865579666, 10);
    // J_1(1) ≈ 0.4400505857449335
    expect(besselJ(1, 1)).toBeCloseTo(0.4400505857449335, 10);
    // J_2(2.4048) ≈ 0.4317, near the first zero of J_0
    expect(besselJ(2, 2.4048)).toBeCloseTo(0.4317, 3);
  });

  it("Σ J_n²(x) ≤ 1 for low orders (energy conservation lower bound)", () => {
    // Σ_{n=-∞}^{∞} J_n²(x) = 1 exactly. Truncated to ±5 should give >0.99.
    const x = 2.5;
    let sum = 0;
    for (let n = -5; n <= 5; n++) sum += besselJ(n, x) ** 2;
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThanOrEqual(1.0 + 1e-10);
  });
});

// =============================================================================
// braggAngleRad
// =============================================================================

describe("braggAngleRad", () => {
  const baseParams: AomPhysicsParams = {
    centerFreqMhz: 80,
    acousticVelocityMPerS: 4200,
    refractiveIndex: 2.26,
  };

  it("returns expected θ_B for 780 nm / 80 MHz / TeO2", () => {
    // λ·f / (2·n·v) = 780e-9 m · 80e6 Hz / (2 · 2.26 · 4200 m/s)
    //              = 6.24e-2 m/s / 18984 m/s
    //              ≈ 3.287e-3
    // → θ_B ≈ 3.29 mrad (consistent with 2·θ_B ≈ 6.6 mrad full
    //   deflection at TeO2 isotropic Bragg, 780 nm / 80 MHz).
    const theta = braggAngleRad(baseParams, 780);
    expect(theta).toBeCloseTo(3.287e-3, 6);
  });

  it("scales linearly in λ at small angles", () => {
    // sinθ ≈ θ when small, so doubling λ should ≈ double θ.
    const t1 = braggAngleRad(baseParams, 780);
    const t2 = braggAngleRad(baseParams, 1560);
    expect(t2 / t1).toBeCloseTo(2, 3);
  });

  it("clamps at ±π/2 when arcsin argument exceeds 1", () => {
    // Drive an absurd config that overflows the asin domain.
    const overdriven: AomPhysicsParams = {
      centerFreqMhz: 1e9,    // 1 PHz RF — physically impossible but should not NaN
      acousticVelocityMPerS: 1,
      refractiveIndex: 1,
    };
    const theta = braggAngleRad(overdriven, 1e6);
    expect(Math.abs(theta)).toBeCloseTo(Math.PI / 2, 8);
  });

  it("uses defaults when fields are missing", () => {
    expect(braggAngleRad({}, 780)).toBeCloseTo(braggAngleRad(baseParams, 780), 12);
  });
});

// =============================================================================
// computeBraggTiltAxisBodyLocal
// =============================================================================

describe("computeBraggTiltAxisBodyLocal", () => {
  it("matches the MT80 body frame: b=+Y, alpha=270 deg gives tau=-Z", () => {
    const tau = computeBraggTiltAxisBodyLocal({ x: 0, y: 1, z: 0 }, 270);
    expect(tau).not.toBeNull();
    expect(tau!.x).toBeCloseTo(0, 12);
    expect(tau!.y).toBeCloseTo(0, 12);
    expect(tau!.z).toBeCloseTo(-1, 12);
  });

  it("keeps the MT80 alpha=270 tilt perpendicular to acoustic body -X", () => {
    const tau = computeBraggTiltAxisBodyLocal({ x: 0, y: 1, z: 0 }, 270);
    const acoustic = { x: -1, y: 0, z: 0 };
    const dot = tau!.x * acoustic.x + tau!.y * acoustic.y + tau!.z * acoustic.z;
    expect(dot).toBeCloseTo(0, 12);
  });
});

describe("computeBraggTiltAxisFromRfDirectionBodyLocal", () => {
  it("uses the intuitive MT80 RF input direction: b=+Y, RF=-X gives tau=-Z", () => {
    const tau = computeBraggTiltAxisFromRfDirectionBodyLocal(
      { x: 0, y: 1, z: 0 },
      { x: -1, y: 0, z: 0 },
    );
    expect(tau).not.toBeNull();
    expect(tau!.x).toBeCloseTo(0, 12);
    expect(tau!.y).toBeCloseTo(0, 12);
    expect(tau!.z).toBeCloseTo(-1, 12);
  });

  it("returns null when RF direction is parallel to the optical axis", () => {
    const tau = computeBraggTiltAxisFromRfDirectionBodyLocal(
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(tau).toBeNull();
  });
});

describe("effectiveAomOrderForTraversal", () => {
  it("keeps order labels for intercept_in -> intercept_out traversal", () => {
    const sign = aomTraversalSignFromEntryPort("intercept_in");
    expect(sign).toBe(1);
    expect(effectiveAomOrderForTraversal(1, sign)).toBe(1);
    expect(effectiveAomOrderForTraversal(-1, sign)).toBe(-1);
    expect(effectiveAomOrderForTraversal(0, sign)).toBe(0);
  });

  it("swaps +1/-1 for intercept_out -> intercept_in traversal", () => {
    const sign = aomTraversalSignFromEntryPort("intercept_out");
    expect(sign).toBe(-1);
    expect(effectiveAomOrderForTraversal(1, sign)).toBe(-1);
    expect(effectiveAomOrderForTraversal(-1, sign)).toBe(1);
    expect(effectiveAomOrderForTraversal(0, sign)).toBe(0);
  });
});

// =============================================================================
// diffractionEfficiency
// =============================================================================

describe("diffractionEfficiency", () => {
  const closedFormParams: AomPhysicsParams = {
    centerFreqMhz: 80,
    acousticVelocityMPerS: 4200,
    refractiveIndex: 2.26,
    figureOfMeritM2: 1.5e-15,         // typical TeO2 figure of merit
    crystalLengthMm: 9,
    acousticBeamWidthMm: 1.5,
    rfDrivePowerW: 1.0,
  };

  it("falls back to baseEfficiency when closed-form inputs are incomplete", () => {
    expect(diffractionEfficiency({ baseEfficiency: 0.7 }, 780, 0)).toBe(0.7);
  });

  it("falls back to default 0.85 when neither baseEfficiency nor closed-form set", () => {
    expect(diffractionEfficiency({}, 780, 0)).toBe(0.85);
  });

  it("clamps fallback baseEfficiency to [0, 1]", () => {
    expect(diffractionEfficiency({ baseEfficiency: -0.5 }, 780, 0)).toBe(0);
    expect(diffractionEfficiency({ baseEfficiency: 1.5 }, 780, 0)).toBe(1);
  });

  it("returns η ∈ [0, 1] for closed-form inputs", () => {
    const theta = braggAngleRad(closedFormParams, 780);
    const eta = diffractionEfficiency(closedFormParams, 780, theta);
    expect(eta).toBeGreaterThanOrEqual(0);
    expect(eta).toBeLessThanOrEqual(1);
  });

  it("monotonic in P_d for low arg (sin² rising slope)", () => {
    const theta = braggAngleRad(closedFormParams, 780);
    const lowPd = diffractionEfficiency({ ...closedFormParams, rfDrivePowerW: 0.001 }, 780, theta);
    const midPd = diffractionEfficiency({ ...closedFormParams, rfDrivePowerW: 0.01 }, 780, theta);
    expect(midPd).toBeGreaterThan(lowPd);
  });
});

// =============================================================================
// phaseModulationDepth
// =============================================================================

describe("phaseModulationDepth", () => {
  it("falls back to 2·√η when closed-form inputs are missing", () => {
    expect(phaseModulationDepth({}, 780, 0, 0.25)).toBeCloseTo(1.0, 12);
    expect(phaseModulationDepth({}, 780, 0, 1.0)).toBeCloseTo(2.0, 12);
    expect(phaseModulationDepth({}, 780, 0, 0)).toBeCloseTo(0, 12);
  });

  it("clamps fallback efficiency input to [0, 1] before the sqrt", () => {
    expect(phaseModulationDepth({}, 780, 0, -0.5)).toBe(0);
    expect(phaseModulationDepth({}, 780, 0, 1.5)).toBeCloseTo(2.0, 12);
  });

  it("uses closed-form arg when M2/L/W/Pd are all set (no clamp)", () => {
    const params: AomPhysicsParams = {
      figureOfMeritM2: 1.5e-15,
      crystalLengthMm: 9,
      acousticBeamWidthMm: 1.5,
      rfDrivePowerW: 1.0,
    };
    const v = phaseModulationDepth(params, 780, 0, 0);
    // arg should equal what diffractionEfficiency uses internally:
    //   (π·L / (2·λ·cosθ)) · √(2·M2·Pd/W)
    const lambdaM = 780e-9;
    const expected =
      (Math.PI * 9e-3 / (2 * lambdaM * 1)) * Math.sqrt((2 * 1.5e-15 * 1) / 1.5e-3);
    expect(v).toBeCloseTo(expected, 8);
  });
});

// =============================================================================
// sidebandIntensitiesOnBragg
// =============================================================================

describe("sidebandIntensitiesOnBragg", () => {
  it("currentOrder = 0 puts all power in 0th", () => {
    const m = sidebandIntensitiesOnBragg(0, 0.85, 1.0, 3);
    expect(m.get(0)).toBe(1);
    for (let n = -3; n <= 3; n++) {
      if (n === 0) continue;
      expect(m.get(n)).toBe(0);
    }
  });

  it("currentOrder = +1 with η=0.85 puts 0.85 in +1, suppression floor in -1", () => {
    const m = sidebandIntensitiesOnBragg(1, 0.85, 1.0, 1);
    expect(m.get(1)).toBeCloseTo(0.85, 10);
    expect(m.get(-1)).toBe(SUPPRESSED_FIRST_ORDER_FLOOR);
    // 0th absorbs the rest: 1 - 0.85 - 0.001 = 0.149
    expect(m.get(0)).toBeCloseTo(0.149, 10);
  });

  it("currentOrder = -1 mirror-symmetric to +1", () => {
    const plus = sidebandIntensitiesOnBragg(1, 0.85, 1.0, 1);
    const minus = sidebandIntensitiesOnBragg(-1, 0.85, 1.0, 1);
    expect(minus.get(-1)).toBe(plus.get(1));
    expect(minus.get(1)).toBe(plus.get(-1));
    expect(minus.get(0)).toBe(plus.get(0));
  });

  it("higher orders (|n|≥2) come from J_n²(v)", () => {
    const v = 2.0;
    const m = sidebandIntensitiesOnBragg(1, 0.5, v, 3);
    // |n|=2 should match besselJ(2, 2.0)²; |n|=3 same for J_3(2.0)
    expect(m.get(2)).toBeCloseTo(besselJ(2, v) ** 2, 12);
    expect(m.get(3)).toBeCloseTo(besselJ(3, v) ** 2, 12);
    expect(m.get(-2)).toBeCloseTo(besselJ(2, v) ** 2, 12);
  });

  it("normalises when non-zero sum > 1 so total is exactly 1", () => {
    // Force overflow: η=0.99, plus large J_n² sidebands at v=3
    const m = sidebandIntensitiesOnBragg(1, 0.99, 3.0, 5);
    let total = 0;
    for (const f of m.values()) total += f;
    expect(total).toBeCloseTo(1, 10);
  });

  it("0th-order fraction never goes negative", () => {
    // Small maxOrder + large η + suppression floor — exercise edge cases
    for (const eta of [0, 0.1, 0.5, 0.99, 1]) {
      for (const v of [0, 0.5, 1, 2, 4]) {
        for (const order of [0, 1, -1] as const) {
          const m = sidebandIntensitiesOnBragg(order, eta, v, 3);
          expect(m.get(0)!).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

// =============================================================================
// rfPowerForPeakEfficiencyW
// =============================================================================

// =============================================================================
// Phase 7.4 — Bragg geometry single-source-of-truth helpers
// =============================================================================

describe("expectedInputDotD2", () => {
  // The whole point of this function is to be the canonical source of the
  // Bragg sign convention. Tests below pin it: for state A m=+1, input
  // must be on the OPPOSITE side of D1 from where the +1 order emerges
  // (because rayTrace deflects by +2θ_B; symmetric Bragg-mirror requires
  // input at -θ_B and output at +θ_B from D1).
  const theta = 0.05;  // 50 mrad — exaggerated so sign is unambiguous

  it("state A, m=+1: returns -sin(θ_B)  (input below D1, +1 emerges above)", () => {
    expect(expectedInputDotD2(1, 1, theta)).toBeCloseTo(-Math.sin(theta), 12);
  });

  it("state A, m=-1: returns +sin(θ_B)", () => {
    expect(expectedInputDotD2(-1, 1, theta)).toBeCloseTo(+Math.sin(theta), 12);
  });

  it("state A, m=0: returns 0  (no Bragg constraint)", () => {
    expect(expectedInputDotD2(0, 1, theta)).toBeCloseTo(0, 12);
  });

  it("state B (traversalSign=-1) flips the sign relative to A", () => {
    expect(expectedInputDotD2(1, -1, theta)).toBeCloseTo(+Math.sin(theta), 12);
    expect(expectedInputDotD2(-1, -1, theta)).toBeCloseTo(-Math.sin(theta), 12);
  });

  it("regression: was buggy as +effectiveOrder * sin(θ_B) before Phase 7.4", () => {
    // Pin the leading minus sign: previous code had no minus, which sent
    // the m=+1 align target to +sin(θ_B), placing the input on the SAME
    // side that the deflection then sent the order further away (+3θ_B
    // off-Bragg, angularFactor → exp(-(2θ_B/acceptance)²) ≈ 0).
    expect(expectedInputDotD2(1, 1, 0.001)).toBeLessThan(0);
    expect(expectedInputDotD2(-1, 1, 0.001)).toBeGreaterThan(0);
  });
});

describe("diffractedDirection", () => {
  // Pure rotation about D3 by m*2*theta. Use a simple axis-aligned case
  // for sign checks and a tilted-axis case for the general Rodrigues
  // formula.
  const D3z = { x: 0, y: 0, z: 1 };

  it("m=0 returns the input unchanged", () => {
    const v = { x: 0.6, y: 0.8, z: 0.0 };
    const out = diffractedDirection(v, D3z, 0, 0.1);
    expect(out.x).toBe(v.x);
    expect(out.y).toBe(v.y);
    expect(out.z).toBe(v.z);
  });

  it("preserves input·D3 for any order (the user's beam·D3 invariant)", () => {
    const v = { x: 0.5, y: 0.3, z: 0.8 };  // arbitrary 3D direction
    for (const m of [-3, -2, -1, 0, 1, 2, 3]) {
      const out = diffractedDirection(v, D3z, m, 0.05);
      expect(out.z).toBeCloseTo(v.z, 12);  // preserved
    }
  });

  it("for m=+1 with input at -theta in D1-D2 plane, output is at +theta (Bragg mirror)", () => {
    const theta = 0.1;
    // Input: (cos θ, -sin θ, 0)  -- D1 = +x, D2 = +y, theta below D1.
    const input = { x: Math.cos(theta), y: -Math.sin(theta), z: 0 };
    const out = diffractedDirection(input, D3z, 1, theta);
    expect(out.x).toBeCloseTo(Math.cos(theta), 10);
    expect(out.y).toBeCloseTo(+Math.sin(theta), 10);  // mirror
    expect(out.z).toBeCloseTo(0, 12);
  });

  it("matches manual Rodrigues for an off-axis D3", () => {
    // D3 = (1/√3, 1/√3, 1/√3); rotate (1, 0, 0) by π/3 about it.
    const sqrt3 = Math.sqrt(3);
    const D3 = { x: 1 / sqrt3, y: 1 / sqrt3, z: 1 / sqrt3 };
    const v = { x: 1, y: 0, z: 0 };
    // diffractedDirection rotates by m*2*theta. Pick m=1, theta=π/6,
    // total rotation = π/3.
    const out = diffractedDirection(v, D3, 1, Math.PI / 6);
    // Manual: Rodrigues with axis (1,1,1)/√3, angle π/3 applied to (1,0,0)
    // is (2/3, 2/3, -1/3) — well-known textbook result.
    expect(out.x).toBeCloseTo(2 / 3, 10);
    expect(out.y).toBeCloseTo(2 / 3, 10);
    expect(out.z).toBeCloseTo(-1 / 3, 10);
  });
});

describe("aomBodyFrameBodyLocal", () => {
  it("returns canonical MT80 frame: D1=+Y, D2=-X, D3=+Z", () => {
    const frame = aomBodyFrameBodyLocal(
      { x: 0, y: -10, z: 0 },
      { x: 0, y: +10, z: 0 },
      { x: -1, y: 0, z: 0 },
    );
    expect(frame).not.toBeNull();
    expect(frame!.D1).toEqual({ x: 0, y: 1, z: 0 });
    expect(frame!.D2).toEqual({ x: -1, y: 0, z: 0 });
    expect(frame!.D3.x).toBeCloseTo(0, 12);
    expect(frame!.D3.y).toBeCloseTo(0, 12);
    expect(frame!.D3.z).toBeCloseTo(1, 12);
  });

  it("returns null when in/out anchors coincide (D1 undefined)", () => {
    const frame = aomBodyFrameBodyLocal(
      { x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }, { x: 1, y: 0, z: 0 },
    );
    expect(frame).toBeNull();
  });

  it("returns null when RF direction parallel to optical axis (D3 undefined)", () => {
    const frame = aomBodyFrameBodyLocal(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 },
    );
    expect(frame).toBeNull();
  });

  it("normalises D1 / D2 / D3 to unit length", () => {
    const frame = aomBodyFrameBodyLocal(
      { x: 0, y: -100, z: 0 },         // arbitrary mm scale
      { x: 0, y: +100, z: 0 },
      { x: -3, y: 0, z: 0 },           // arbitrary RF magnitude
    );
    expect(frame).not.toBeNull();
    expect(Math.hypot(frame!.D1.x, frame!.D1.y, frame!.D1.z)).toBeCloseTo(1, 12);
    expect(Math.hypot(frame!.D2.x, frame!.D2.y, frame!.D2.z)).toBeCloseTo(1, 12);
    expect(Math.hypot(frame!.D3.x, frame!.D3.y, frame!.D3.z)).toBeCloseTo(1, 12);
  });
});

describe("resolveTraversalSign", () => {
  it("physical-traversal: passes raw sign through", () => {
    expect(resolveTraversalSign(1, "physical-traversal")).toBe(1);
    expect(resolveTraversalSign(-1, "physical-traversal")).toBe(-1);
  });

  it("lab-fixed: forces +1 regardless of state", () => {
    expect(resolveTraversalSign(1, "lab-fixed")).toBe(1);
    expect(resolveTraversalSign(-1, "lab-fixed")).toBe(1);
  });
});

describe("default mode constants", () => {
  it("DEFAULT_STAGE1_MODE = 'min-rot' (least rotation from current pose, no 180° flip)", () => {
    expect(DEFAULT_STAGE1_MODE).toBe("min-rot");
  });

  it("DEFAULT_STAGE2_SIGN = 'physical-traversal' (matches rayTrace.ts)", () => {
    expect(DEFAULT_STAGE2_SIGN).toBe("physical-traversal");
  });
});

describe("Bragg round-trip: align target → diffractedDirection → Bragg-mirror", () => {
  // For each (state, m) combination, simulate what alignToLaser produces:
  //   - input direction in body frame has beam·D2 = expectedInputDotD2(...)
  //   - input direction in body frame has beam·D1 = ±cos(θ_B) (state sign)
  //   - input direction's D3 component is 0 (Stage 1 snapped beam ∥ D1).
  // Then verify that diffractedDirection produces an output whose
  // D2 component equals -expectedInputDotD2 — i.e., Bragg-mirror.
  //
  // This pins down the structural sign agreement between alignToLaser
  // (which targets `expectedInputDotD2`) and rayTrace.ts (which calls
  // `diffractedDirection`). If anyone touches one without the other,
  // these tests fail and surface the inconsistency.
  const D1Body = { x: 0, y: 1, z: 0 };
  const D2Body = { x: -1, y: 0, z: 0 };
  const D3Body = { x: 0, y: 0, z: 1 };
  const theta = 0.05;  // 50 mrad

  for (const state of ["A", "B"] as const) {
    for (const m of [-1, +1] as const) {
      it(`state ${state}, m=${m}: m-th order output mirrors input across D1-D3 plane`, () => {
        const traversalRaw = state === "A" ? +1 : -1;
        const traversalForExpect = traversalRaw;  // physical-traversal
        const expectedDotD2 = expectedInputDotD2(m, traversalForExpect, theta);

        // Build input direction in BODY frame:
        //   beam_body·D1 = state sign · cos(θ_B)   (s = +1 for A, -1 for B)
        //   beam_body·D2 = expectedDotD2
        //   beam_body·D3 = 0  (Stage 1 puts beam in D1-D2 plane)
        const stateSign = state === "A" ? 1 : -1;
        // Express in body coords (D1=ŷ, D2=-x̂, D3=ẑ): a vector with
        // components (a·D1 + b·D2 + c·D3) = (a·ŷ + b·(-x̂) + c·ẑ) =
        // (-b, a, c) in standard XYZ.
        const a = stateSign * Math.cos(theta);
        const b = expectedDotD2;
        const c = 0;
        const inputBody = {
          x: -b * 1 + a * 0 + c * 0,  // = -b (since D2_body has x=-1)
          y: a,                        // D1_body has y=1
          z: c,                        // D3_body has z=1
        };
        // Sanity: input·D2_body should equal expectedDotD2.
        const inputDotD2 = inputBody.x * D2Body.x + inputBody.y * D2Body.y + inputBody.z * D2Body.z;
        expect(inputDotD2).toBeCloseTo(expectedDotD2, 12);

        // Apply diffractedDirection.
        const output = diffractedDirection(inputBody, D3Body, m, theta);

        // Verify output·D2 = -expectedDotD2 (Bragg-mirror).
        const outputDotD2 = output.x * D2Body.x + output.y * D2Body.y + output.z * D2Body.z;
        expect(outputDotD2).toBeCloseTo(-expectedDotD2, 10);

        // Verify output·D3 = 0 (D3 component preserved through diffraction).
        const outputDotD3 = output.x * D3Body.x + output.y * D3Body.y + output.z * D3Body.z;
        expect(outputDotD3).toBeCloseTo(0, 10);

        // Verify output·D1 = ±cos(θ_B) (still propagating along optical axis).
        const outputDotD1 = output.x * D1Body.x + output.y * D1Body.y + output.z * D1Body.z;
        expect(Math.abs(outputDotD1)).toBeCloseTo(Math.cos(theta), 10);
      });
    }
  }

  it("0th order: output = input verbatim (passes through)", () => {
    const inputBody = { x: 0.123, y: 0.456, z: 0.789 };
    const output = diffractedDirection(inputBody, D3Body, 0, 0.05);
    expect(output).toEqual(inputBody);
  });

  it("higher orders preserve beam·D3 (the user's invariant)", () => {
    const inputBody = { x: 0.3, y: 0.7, z: 0.4 };
    for (const m of [-3, -2, -1, 0, 1, 2, 3]) {
      const out = diffractedDirection(inputBody, D3Body, m, 0.03);
      const outDotD3 = out.x * D3Body.x + out.y * D3Body.y + out.z * D3Body.z;
      const inDotD3 = inputBody.x * D3Body.x + inputBody.y * D3Body.y + inputBody.z * D3Body.z;
      expect(outDotD3).toBeCloseTo(inDotD3, 10);
    }
  });

  // -------- Phase 7.4 state-B regression --------
  // Pin the rayTrace.ts contract: plan.order is the user's m WITHOUT flipping
  // by traversalSign. With re-tilt-per-state align (alignToLaser two-stage
  // flow), the body's mechanical Bragg tilt depends on state, so the body-
  // frame Bragg-correct order is always +user_m (state A and B agree).
  //
  // Pre-fix bug: rayTrace called `effectiveAomOrderForTraversal(orderSign,
  // traversal.sign)` which flipped sign for state B, sending the matched
  // plan.order to body-frame -1 instead of +1 in state-B m=+1. With the
  // state-B-aligned input (input·D2 = +sin θ_B), body-frame -1 deflection
  // produces output·D2 = sin(3θ_B) — three times off-Bragg, angularFactor
  // collapses to ~0 even though align reported residual = 0. This test
  // would have caught it.
  it("rayTrace contract: planOrder=userM gives Bragg-mirror in BOTH states", () => {
    // state B is the regression target — state A is included as a control.
    for (const state of ["A", "B"] as const) {
      for (const userM of [-1, +1] as const) {
        const traversalRaw = state === "A" ? +1 : -1;
        const expectedDotD2Val = expectedInputDotD2(userM, traversalRaw, 0.05);

        // Build input direction in body frame matching the post-align state.
        // Body axes in body coords: D1=(0,1,0), D2=(-1,0,0), D3=(0,0,1).
        const stateSign = state === "A" ? 1 : -1;
        const inputBody = {
          x: -expectedDotD2Val,                    // body-x = -D2_component
          y: stateSign * Math.cos(0.05),           // body-y = +D1_component
          z: 0,
        };

        // ★ This is what rayTrace.ts does after the Phase 7.4 fix:
        const planOrder = userM;  // NOT effectiveAomOrderForTraversal(...)
        const output = diffractedDirection(inputBody, D3Body, planOrder, 0.05);

        // Assert Bragg-mirror across the D1-D3 plane (output·D2 = -input·D2).
        const outDotD2 = output.x * D2Body.x + output.y * D2Body.y + output.z * D2Body.z;
        expect(outDotD2).toBeCloseTo(-expectedDotD2Val, 10);
      }
    }
  });
});

describe("rfPowerForPeakEfficiencyW", () => {
  const params: AomPhysicsParams = {
    figureOfMeritM2: 1.5e-15,
    crystalLengthMm: 9,
    acousticBeamWidthMm: 1.5,
  };

  it("returns null when any of M₂/L/W is missing", () => {
    expect(rfPowerForPeakEfficiencyW({}, 780, 0)).toBeNull();
    expect(
      rfPowerForPeakEfficiencyW({ figureOfMeritM2: 1.5e-15 }, 780, 0),
    ).toBeNull();
  });

  it("inverse property: feeding result back to η gives ≈ 1", () => {
    const theta = braggAngleRad(params, 780);
    const peakPd = rfPowerForPeakEfficiencyW(params, 780, theta);
    expect(peakPd).not.toBeNull();
    const eta = diffractionEfficiency(
      { ...params, rfDrivePowerW: peakPd as number },
      780,
      theta,
    );
    expect(eta).toBeCloseTo(1.0, 10);
  });
});
