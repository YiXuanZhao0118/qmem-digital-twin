/**
 * Parity test runner — reads a golden fixture JSON, runs it through the
 * v3 ray tracer, and asserts the result matches expected within tolerance.
 *
 * The SAME JSON is consumed by `backend/tests/optical/parity/test_parity.py`,
 * so any divergence between TS and Python is caught immediately.
 *
 * Phase 3d scope: TS + Python self-consistency on lens / mirror / polarizer.
 * Phase 7+: extend to v2 vs v3 cross-tracer parity once the v2 tracer is
 * deprecated.
 */

import { expect } from "vitest";

import {
  type BeamRay,
  type Vec3,
  makeBeamRay,
} from "../../beam-ray";
import { type Complex } from "../../fiber/gaussian";
import {
  type V3AssetSnapshot,
  type V3TransitionDescriptor,
  traceRayThroughAsset,
} from "../../ray-tracer-v3";
import type { Face } from "../../registry";

// ---------------------------------------------------------------------------
// Fixture schema
// ---------------------------------------------------------------------------

type FixtureFace = {
  id: string;
  positionMmBodyLocal: Vec3;
  normalBodyLocal?: Vec3;
  apertureMm: number;
  apertureShape?: "rectangle" | "ellipse" | "circle";
};

type FixtureTransition = {
  in: string;
  via?: string[];
  out: string | string[];
  op: string;
  params?: Record<string, unknown>;
  matrix5x5?: number[][];
  abcd?: number[][];
};

type FixtureAsset = {
  catalogId: string;
  kind: string;
  faces: FixtureFace[];
  transitions: FixtureTransition[];
  defaultParams: Record<string, unknown>;
};

type FixtureRayIn = {
  origin: Vec3;
  direction: Vec3;
  wavelengthNm: number;
  waistRadiusMm: number;
  powerMw: number;
  jones: [Complex, Complex];
};

type FixtureExpectedRay = {
  origin: Vec3;
  direction: Vec3;
  pathLengthMm?: number;
  powerMw: number;
  wavelengthNm: number;
  qxAfterLens?: Complex;
  qyAfterLens?: Complex;
};

type FixtureExpected = {
  finalRayCount: number;
  rays: FixtureExpectedRay[];
};

type FixtureTolerance = {
  positionMm: number;
  directionAbs: number;
  powerMw: number;
  qAbs: number;
};

export type ParityFixture = {
  name: string;
  description?: string;
  asset: FixtureAsset;
  rayIn: FixtureRayIn;
  expected: FixtureExpected;
  tolerance: FixtureTolerance;
};

// ---------------------------------------------------------------------------
// Conversion: fixture → v3 runtime
// ---------------------------------------------------------------------------

function toFace(f: FixtureFace): Face {
  return {
    id: f.id,
    positionMmBodyLocal: f.positionMmBodyLocal,
    normalBodyLocal: f.normalBodyLocal,
    apertureMm: f.apertureMm,
    apertureShape: f.apertureShape ?? "rectangle",
  };
}

function toTransition(t: FixtureTransition): V3TransitionDescriptor {
  return {
    in: t.in,
    via: t.via ?? null,
    out: t.out,
    op: t.op,
    params: t.params ?? null,
    matrix5x5: t.matrix5x5 ?? null,
    abcd: t.abcd ?? null,
  };
}

function toAsset(a: FixtureAsset): V3AssetSnapshot {
  return {
    catalogId: a.catalogId,
    kind: a.kind,
    faces: a.faces.map(toFace),
    transitions: a.transitions.map(toTransition),
    defaultParams: a.defaultParams,
  };
}

function toBeamRay(r: FixtureRayIn): BeamRay {
  return {
    ...makeBeamRay({
      origin: r.origin,
      direction: r.direction,
      wavelengthNm: r.wavelengthNm,
      waistRadiusMm: r.waistRadiusMm,
      powerMw: r.powerMw,
    }),
    jones: r.jones,
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assertVec3Close(
  actual: Vec3, expected: Vec3, tol: number, label: string,
): void {
  expect(actual.x, `${label}.x`).toBeCloseTo(expected.x, -Math.log10(tol));
  expect(actual.y, `${label}.y`).toBeCloseTo(expected.y, -Math.log10(tol));
  expect(actual.z, `${label}.z`).toBeCloseTo(expected.z, -Math.log10(tol));
}

function assertComplexClose(
  actual: Complex, expected: Complex, tol: number, label: string,
): void {
  expect(actual.re, `${label}.re`).toBeCloseTo(expected.re, -Math.log10(tol));
  expect(actual.im, `${label}.im`).toBeCloseTo(expected.im, -Math.log10(tol));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runFixture(fixture: ParityFixture): void {
  const asset = toAsset(fixture.asset);
  const rayIn = toBeamRay(fixture.rayIn);
  const result = traceRayThroughAsset(rayIn, asset);

  expect(
    result.finalRays.length,
    `${fixture.name}: finalRayCount`,
  ).toBe(fixture.expected.finalRayCount);

  for (let i = 0; i < fixture.expected.rays.length; i++) {
    const exp = fixture.expected.rays[i]!;
    const act = result.finalRays[i]!;

    assertVec3Close(act.origin, exp.origin, fixture.tolerance.positionMm, `[${i}] origin`);
    assertVec3Close(act.direction, exp.direction, fixture.tolerance.directionAbs, `[${i}] direction`);

    expect(act.powerMw, `[${i}] powerMw`).toBeCloseTo(
      exp.powerMw, -Math.log10(fixture.tolerance.powerMw),
    );
    expect(act.wavelengthNm, `[${i}] wavelengthNm`).toBe(exp.wavelengthNm);

    if (exp.pathLengthMm !== undefined) {
      expect(act.pathLengthMm, `[${i}] pathLengthMm`).toBeCloseTo(
        exp.pathLengthMm, -Math.log10(fixture.tolerance.positionMm),
      );
    }

    if (exp.qxAfterLens) {
      assertComplexClose(act.qx, exp.qxAfterLens, fixture.tolerance.qAbs, `[${i}] qx`);
    }
    if (exp.qyAfterLens) {
      assertComplexClose(act.qy, exp.qyAfterLens, fixture.tolerance.qAbs, `[${i}] qy`);
    }
  }
}
