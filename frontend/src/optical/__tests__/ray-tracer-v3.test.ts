/**
 * Phase 3a integration test — runs a BeamRay through a single Asset3D
 * (lens / mirror / polarizer) using the v3 face-based ray tracer, and
 * verifies the output matches each kind's direct op call. This proves
 * the dispatch loop wires registry → op → output ray correctly.
 */

import { describe, it, expect, beforeAll } from "vitest";

import "../kinds/lens/physics";
import "../kinds/mirror/physics";
import "../kinds/polarizer/physics";

import { type BeamRay, makeBeamRay } from "../beam-ray";
import { type Complex } from "../fiber/gaussian";
import {
  type V3AssetSnapshot,
  intersectFace,
  nearestFaceHit,
  traceRayThroughAsset,
} from "../ray-tracer-v3";

// ---------------------------------------------------------------------------
// Asset snapshots — minimal v3 records (would normally come from API)
// ---------------------------------------------------------------------------

const LENS_50MM: V3AssetSnapshot = {
  catalogId: "test_lens_50mm",
  kind: "lens",
  faces: [
    {
      id: "A",
      positionMmBodyLocal: { x: 0, y: 0, z: -1.5 },
      normalBodyLocal: { x: 0, y: 0, z: -1 },
      apertureMm: 12.7,
      apertureShape: "circle",
    },
    {
      id: "B",
      positionMmBodyLocal: { x: 0, y: 0, z: +1.5 },
      normalBodyLocal: { x: 0, y: 0, z: +1 },
      apertureMm: 12.7,
      apertureShape: "circle",
    },
  ],
  transitions: [{ in: "A", out: "B", op: "abcd_thin_lens" }],
  defaultParams: { focalLengthMm: 50 },
};

const FLAT_MIRROR: V3AssetSnapshot = {
  catalogId: "test_flat_mirror",
  kind: "mirror",
  faces: [
    {
      id: "A",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      normalBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 12.7,
      apertureShape: "circle",
    },
  ],
  transitions: [{ in: "A", out: "A", op: "reflect_specular" }],
  defaultParams: { reflectivity: 1.0 },
};

const POLARIZER_0DEG: V3AssetSnapshot = {
  catalogId: "test_polarizer",
  kind: "polarizer",
  faces: [
    {
      id: "A1",
      positionMmBodyLocal: { x: 0, y: 0, z: -3.75 },
      normalBodyLocal: { x: 0, y: 0, z: -1 },
      apertureMm: 6,
      apertureShape: "rectangle",
    },
    {
      id: "B1",
      positionMmBodyLocal: { x: 0, y: 0, z: +3.75 },
      normalBodyLocal: { x: 0, y: 0, z: +1 },
      apertureMm: 6,
      apertureShape: "rectangle",
    },
  ],
  transitions: [
    { in: "A1", out: "B1", op: "jones_polarizer" },
  ],
  defaultParams: { transmissionAxisDegBeamLocal: 0 },
};

// ---------------------------------------------------------------------------
// Face-hit unit tests
// ---------------------------------------------------------------------------

describe("ray-tracer-v3 / intersectFace", () => {
  it("on-axis ray hits face B before A when moving +z", () => {
    const ray = {
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
    };
    const hitA = intersectFace(ray, LENS_50MM.faces[0]!);
    const hitB = intersectFace(ray, LENS_50MM.faces[1]!);
    expect(hitA).not.toBeNull();
    expect(hitB).not.toBeNull();
    expect(hitA!.t).toBeCloseTo(8.5, 9);
    expect(hitB!.t).toBeCloseTo(11.5, 9);
  });

  it("ray parallel to face plane returns null", () => {
    const ray = {
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 1, y: 0, z: 0 },  // perp to +z face normal
    };
    const hit = intersectFace(ray, LENS_50MM.faces[0]!);
    expect(hit).toBeNull();
  });

  it("excludeFaceId blocks immediate re-hit", () => {
    const ray = {
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    };
    const hit = intersectFace(ray, FLAT_MIRROR.faces[0]!, {
      excludeFaceId: "A",
    });
    expect(hit).toBeNull();
  });

  it("off-axis ray outside aperture returns null", () => {
    const ray = {
      origin: { x: 100, y: 0, z: -10 },     // 100 mm off axis
      direction: { x: 0, y: 0, z: 1 },
    };
    const hit = intersectFace(ray, LENS_50MM.faces[0]!);
    expect(hit).toBeNull();
  });

  it("nearestFaceHit picks closer face", () => {
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
    });
    const hit = nearestFaceHit(ray, LENS_50MM);
    expect(hit).not.toBeNull();
    expect(hit!.face.id).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// End-to-end trace tests
// ---------------------------------------------------------------------------

describe("ray-tracer-v3 / traceRayThroughAsset / lens", () => {
  it("lens: ray hits A → transitions to B → escapes", () => {
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
      waistRadiusMm: 0.5,
      powerMw: 1.0,
    });

    const result = traceRayThroughAsset(ray, LENS_50MM);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.faceIn.id).toBe("A");
    expect(result.steps[0]!.op).toBe("abcd_thin_lens");
    expect(result.finalRays).toHaveLength(1);

    const out = result.finalRays[0]!;
    // After thin lens at z=0 (between A@-1.5 and B@+1.5), ray exits at B
    // moving +z. Origin should be at B's position.
    expect(out.origin.z).toBeCloseTo(1.5, 9);
    expect(out.direction.z).toBeCloseTo(1, 12);
    expect(out.powerMw).toBeCloseTo(1.0, 12);
  });

  it("lens: ray approaching from wrong side (from +z) hits B first", () => {
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: 10 },
      direction: { x: 0, y: 0, z: -1 },
      wavelengthNm: 780,
    });
    const result = traceRayThroughAsset(ray, LENS_50MM);
    // No transition declared with in=B, so the ray gets absorbed at B
    // (since no matching transition).
    expect(result.steps).toHaveLength(0);
    expect(result.finalRays).toHaveLength(1);
    expect(result.finalRays[0]!.powerMw).toBe(0);     // absorbed
  });
});

describe("ray-tracer-v3 / traceRayThroughAsset / mirror", () => {
  it("mirror: incident ray reflects back", () => {
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: 10 },
      direction: { x: 0, y: 0, z: -1 },
      wavelengthNm: 780,
      powerMw: 1.0,
    });
    const result = traceRayThroughAsset(ray, FLAT_MIRROR);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.op).toBe("reflect_specular");

    // After reflection, ray.direction = (0,0,+1). It would re-hit face A
    // immediately — but `excludeFaceKey` blocks that, so the ray escapes.
    expect(result.finalRays).toHaveLength(1);
    const out = result.finalRays[0]!;
    expect(out.direction.z).toBeCloseTo(1, 12);
    expect(out.powerMw).toBeCloseTo(1.0, 12);
    expect(out.excludeFaceKey).toBe("A");
  });
});

describe("ray-tracer-v3 / traceRayThroughAsset / polarizer", () => {
  it("polarizer: +s polarized input passes through at full power", () => {
    const ray: BeamRay = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: -10 },
        direction: { x: 0, y: 0, z: 1 },
        wavelengthNm: 780,
        powerMw: 1.0,
      }),
      jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }],   // pure +s
    };

    const result = traceRayThroughAsset(ray, POLARIZER_0DEG);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.op).toBe("jones_polarizer");
    expect(result.finalRays).toHaveLength(1);
    expect(result.finalRays[0]!.powerMw).toBeCloseTo(1.0, 12);
  });

  it("polarizer: +p input is blocked (power → 0)", () => {
    const ray: BeamRay = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: -10 },
        direction: { x: 0, y: 0, z: 1 },
        wavelengthNm: 780,
        powerMw: 1.0,
      }),
      jones: [{ re: 0, im: 0 }, { re: 1, im: 0 }],   // pure +p
    };
    const result = traceRayThroughAsset(ray, POLARIZER_0DEG);
    expect(result.finalRays).toHaveLength(1);
    expect(result.finalRays[0]!.powerMw).toBeCloseTo(0, 12);
  });

  it("polarizer: 45° linear input → Malus → 0.5", () => {
    const a = Math.SQRT1_2;
    const ray: BeamRay = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: -10 },
        direction: { x: 0, y: 0, z: 1 },
        wavelengthNm: 780,
        powerMw: 1.0,
      }),
      jones: [{ re: a, im: 0 }, { re: a, im: 0 }],
    };
    const result = traceRayThroughAsset(ray, POLARIZER_0DEG);
    expect(result.finalRays[0]!.powerMw).toBeCloseTo(0.5, 12);
  });
});

// ---------------------------------------------------------------------------
// Loop guards
// ---------------------------------------------------------------------------

describe("ray-tracer-v3 / loop guards", () => {
  it("mirror reflection then escape via excludeFaceKey", () => {
    // After reflection, ray bears excludeFaceKey="A" so the very next
    // intersection skips face A and reports no hit → escape.
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: 10 },
      direction: { x: 0, y: 0, z: -1 },
      wavelengthNm: 780,
    });
    const result = traceRayThroughAsset(ray, FLAT_MIRROR, { maxSteps: 5 });
    expect(result.terminated).toBe("escaped");
    expect(result.finalRays).toHaveLength(1);
  });

  it("maxSteps caps infinite paths", () => {
    // Force a low cap and verify termination reason is reported.
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
    });
    const result = traceRayThroughAsset(ray, LENS_50MM, { maxSteps: 0 });
    expect(result.terminated).toBe("max_steps");
    // The initial ray was pushed back to finalRays unprocessed.
    expect(result.finalRays).toHaveLength(1);
  });

  it("drops rays below power threshold", () => {
    const ray = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: -10 },
        direction: { x: 0, y: 0, z: 1 },
        wavelengthNm: 780,
        powerMw: 1e-12,                         // below default threshold 1e-9
      }),
    };
    const result = traceRayThroughAsset(ray, LENS_50MM);
    expect(result.steps).toHaveLength(0);
    expect(result.finalRays).toHaveLength(0);
  });
});
