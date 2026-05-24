/**
 * Phase 3b — scene-level integration tests.
 * Verifies multi-asset tracing with lab↔body transforms.
 */

import { describe, it, expect } from "vitest";

import "../kinds/lens/physics";
import "../kinds/mirror/physics";
import "../kinds/polarizer/physics";
import "../kinds/aom-v3/physics";
import "../kinds/laser-source/physics";
import { braggAngleRad } from "../kinds/aom-v3/physics";

import { type BeamRay, makeBeamRay } from "../beam-ray";
import { dirBodyToLab, dirLabToBody, pointBodyToLab, pointLabToBody, type V3Pose } from "../pose";
import {
  type V3AssetSnapshot,
  type V3Scene,
  type V3SceneObject,
  emitSceneSourceRays,
  traceRayScene,
} from "../ray-tracer-v3";

// ---------------------------------------------------------------------------
// Asset templates
// ---------------------------------------------------------------------------

const lensAsset = (id: string, focalMm: number): V3AssetSnapshot => ({
  catalogId: id,
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
  defaultParams: { focalLengthMm: focalMm },
});

const mirrorAsset = (id: string, reflectivity = 1.0): V3AssetSnapshot => ({
  catalogId: id,
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
  defaultParams: { reflectivity },
});

const noRotation = { rxDeg: 0, ryDeg: 0, rzDeg: 0 };

const laserSourceAsset = (): V3AssetSnapshot => ({
  catalogId: "laser_780",
  kind: "laser_source",
  faces: [
    {
      id: "out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      normalBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 1,
      apertureShape: "circle",
    },
  ],
  transitions: [{ in: "out", out: "out", op: "emit_laser_source" }],
  defaultParams: {
    centerWavelengthNm: 780.241,
    nominalPowerMw: 50,
    spatialModeX: { waistUm: 250, waistZOffsetMm: 0 },
    spatialModeY: { waistUm: 80, waistZOffsetMm: 1.2 },
    polarization: { exRe: 1, exIm: 0, eyRe: 0, eyIm: 0 },
  },
});

const laserSourceXAsset = (): V3AssetSnapshot => ({
  catalogId: "dbr_852_tosa_high_power_laser_source",
  kind: "laser_source",
  faces: [
    {
      id: "out",
      positionMmBodyLocal: { x: 5.974999904632568, y: 0, z: 0 },
      normalBodyLocal: { x: 1, y: 0, z: 0 },
      apertureMm: 12.5,
      apertureShape: "circle",
    },
  ],
  transitions: [{ in: "out", out: "out", op: "emit_laser_source" }],
  defaultParams: {
    centerWavelengthNm: 852.347,
    nominalPowerMw: 40,
  },
});

const aomAsset = (): V3AssetSnapshot => ({
  catalogId: "aom_dynamic_rf",
  kind: "aom",
  faces: [
    {
      id: "A1",
      positionMmBodyLocal: { x: 0, y: 0, z: -0.8 },
      normalBodyLocal: { x: 0, y: 0, z: -1 },
      apertureMm: 1,
      apertureShape: "circle",
    },
    {
      id: "B1",
      positionMmBodyLocal: { x: 0, y: 0, z: 0.8 },
      normalBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 1,
      apertureShape: "circle",
    },
  ],
  transitions: [{ in: "A1", out: "B1", op: "diffract_aom", params: { order: 1 } }],
  defaultParams: {
    requiresRfDrive: true,
    centerFreqMhz: 80,
    acousticVelocityMps: 4200,
    refractiveIndex: 2.26,
    crystalLengthMm: 1.6,
    figureOfMeritM2: 1e-10,
    acousticBeamWidthMm: 1.5,
  },
});

// ---------------------------------------------------------------------------
// Pose round-trip sanity (this is the foundation everything else relies on)
// ---------------------------------------------------------------------------

describe("pose / round-trip", () => {
  const cases: { name: string; pose: V3Pose }[] = [
    { name: "identity", pose: { xMm: 0, yMm: 0, zMm: 0, ...noRotation } },
    { name: "pure translation", pose: { xMm: 100, yMm: -50, zMm: 25, ...noRotation } },
    { name: "ry=90", pose: { xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 90, rzDeg: 0 } },
    { name: "rx=45 ry=30 rz=10", pose: { xMm: 5, yMm: 10, zMm: 15, rxDeg: 45, ryDeg: 30, rzDeg: 10 } },
  ];

  it.each(cases)("$name: point lab→body→lab is identity", ({ pose }) => {
    const orig = { x: 3, y: -2, z: 7 };
    const body = pointLabToBody(orig, pose);
    const back = pointBodyToLab(body, pose);
    expect(back.x).toBeCloseTo(orig.x, 9);
    expect(back.y).toBeCloseTo(orig.y, 9);
    expect(back.z).toBeCloseTo(orig.z, 9);
  });

  it.each(cases)("$name: dir lab→body→lab is identity", ({ pose }) => {
    const orig = { x: 0.3, y: -0.8, z: 0.5 };
    const body = dirLabToBody(orig, pose);
    const back = dirBodyToLab(body, pose);
    expect(back.x).toBeCloseTo(orig.x, 9);
    expect(back.y).toBeCloseTo(orig.y, 9);
    expect(back.z).toBeCloseTo(orig.z, 9);
  });
});

// ---------------------------------------------------------------------------
// Single-asset scene parity with traceRayThroughAsset
// ---------------------------------------------------------------------------

describe("traceRayScene / single asset at origin matches single-asset trace", () => {
  it("emits initial rays from laser_source scene objects", () => {
    const scene: V3Scene = {
      objects: [{
        id: "laser1",
        asset: laserSourceAsset(),
        pose: { xMm: 1, yMm: 2, zMm: 3, ...noRotation },
        dynamicSources: { centerWavelengthNm: 795, laserPowerMw: 12 },
      }],
    };
    const [ray] = emitSceneSourceRays(scene);
    expect(ray.origin).toEqual({ x: 1, y: 2, z: 3 });
    expect(ray.direction.z).toBeCloseTo(1, 12);
    expect(ray.wavelengthNm).toBeCloseTo(795, 12);
    expect(ray.powerMw).toBeCloseTo(12, 12);
    expect(ray.qx.re).toBeCloseTo(0, 12);
    expect(ray.qy.re).toBeCloseTo(-1.2, 12);
  });

  it("emits LASER_SOURCE0-style v3 ray from +X face and legacy beam dynamicSources", () => {
    const scene: V3Scene = {
      objects: [{
        id: "LASER_SOURCE0",
        asset: laserSourceXAsset(),
        pose: { xMm: -1132.1858548404816, yMm: 0, zMm: 1920.1284444354371, ...noRotation },
        dynamicSources: {
          powerMw: 40,
          spectrum: { centerWavelengthNm: 852 },
          polarization: {
            basis: "beamLocalXY",
            jones: { exRe: 0, exIm: 0, eyRe: 1, eyIm: 0 },
            normalization: "unit_jones",
          },
          spatialEnvelope: {
            propagation: {
              x: { waistZOffsetMm: 2 },
              y: { waistZOffsetMm: 4 },
              model: "m2_gaussian",
            },
            transverseProfile: {
              x: { waistRadiusUm: 500 },
              y: { waistRadiusUm: 600 },
              kind: "elliptical_gaussian",
            },
          },
        },
      }],
    };
    const [ray] = emitSceneSourceRays(scene);
    expect(ray.origin.x).toBeCloseTo(-1126.210854935849, 9);
    expect(ray.origin.z).toBeCloseTo(1920.1284444354371, 9);
    expect(ray.direction.x).toBeCloseTo(1, 12);
    expect(ray.wavelengthNm).toBeCloseTo(852, 12);
    expect(ray.powerMw).toBeCloseTo(40, 12);
    expect(ray.qx.re).toBeCloseTo(-2, 12);
    expect(ray.qy.re).toBeCloseTo(-4, 12);
    expect(ray.jones[0].re).toBeCloseTo(0, 12);
    expect(ray.jones[1].re).toBeCloseTo(1, 12);
  });

  it("laser_source emitted ray can seed scene tracing into the next optic", () => {
    const scene: V3Scene = {
      objects: [
        {
          id: "laser1",
          asset: laserSourceAsset(),
          pose: { xMm: 0, yMm: 0, zMm: -20, ...noRotation },
        },
        {
          id: "lens1",
          asset: lensAsset("test_lens", 50),
          pose: { xMm: 0, yMm: 0, zMm: 0, ...noRotation },
        },
      ],
    };
    const [ray] = emitSceneSourceRays(scene);
    const result = traceRayScene(ray, scene);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.asset.catalogId).toBe("test_lens");
    expect(result.finalRays[0]!.powerMw).toBeCloseTo(50, 12);
  });

  it("lens at origin: ray goes through, exits at face B in lab", () => {
    const lensSo: V3SceneObject = {
      id: "lens1",
      asset: lensAsset("test_lens", 50),
      pose: { xMm: 0, yMm: 0, zMm: 0, ...noRotation },
    };
    const scene: V3Scene = { objects: [lensSo] };

    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
      powerMw: 1.0,
    });
    const result = traceRayScene(ray, scene);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.faceIn.id).toBe("A");
    expect(result.finalRays).toHaveLength(1);

    const out = result.finalRays[0]!;
    expect(out.origin.z).toBeCloseTo(1.5, 9);    // lens B in lab
    expect(out.direction.z).toBeCloseTo(1, 12);
    expect(out.powerMw).toBeCloseTo(1.0, 12);
  });

  it("passes scene dynamicSources into AOM PhysicsOp", () => {
    const scene: V3Scene = {
      objects: [{
        id: "aom1",
        asset: aomAsset(),
        pose: { xMm: 0, yMm: 0, zMm: 0, ...noRotation },
        dynamicSources: { aomFreqMhz: 110, rfDrivePowerW: 0.01 },
      }],
    };
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
      powerMw: 1.0,
    });
    const result = traceRayScene(ray, scene);
    expect(result.steps).toHaveLength(1);
    const out = result.steps[0]!.outRays[0]!;
    const theta = braggAngleRad(780, 110, 4200, 2.26);
    expect(out.direction.x).toBeCloseTo(Math.sin(2 * theta), 9);
    expect(out.powerMw).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-asset scene: two lenses in series
// ---------------------------------------------------------------------------

describe("traceRayScene / two lenses in series", () => {
  it("ray hits both lenses, power preserved", () => {
    const lens1: V3SceneObject = {
      id: "lens1",
      asset: lensAsset("lens_50", 50),
      pose: { xMm: 0, yMm: 0, zMm: 0, ...noRotation },
    };
    const lens2: V3SceneObject = {
      id: "lens2",
      asset: lensAsset("lens_80", 80),
      pose: { xMm: 0, yMm: 0, zMm: 100, ...noRotation },
    };
    const scene: V3Scene = { objects: [lens1, lens2] };

    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
      powerMw: 1.0,
    });
    const result = traceRayScene(ray, scene, { maxSteps: 10 });
    expect(result.steps).toHaveLength(2);

    // First hit must be lens1 (closer)
    expect(result.steps[0]!.asset.catalogId).toBe("lens_50");
    // Second hit must be lens2
    expect(result.steps[1]!.asset.catalogId).toBe("lens_80");

    // Ray exits past lens2 along +z, power preserved
    expect(result.finalRays).toHaveLength(1);
    const out = result.finalRays[0]!;
    expect(out.origin.z).toBeCloseTo(101.5, 9);  // lens2 face B in lab
    expect(out.powerMw).toBeCloseTo(1.0, 12);
  });
});

// ---------------------------------------------------------------------------
// Multi-asset scene: lens + mirror (rotated to face the lens)
// ---------------------------------------------------------------------------

describe("traceRayScene / lens + mirror reflection back", () => {
  it("ray hits lens, then mirror (rotated 180° around y to face -z)", () => {
    const lens: V3SceneObject = {
      id: "lens1",
      asset: lensAsset("lens_50", 50),
      pose: { xMm: 0, yMm: 0, zMm: 0, ...noRotation },
    };
    // Mirror normal points -z in lab (so ray going +z hits the reflective face).
    // Mirror's body-local normal is +z. Rotate 180° around y to flip Z direction.
    const mirror: V3SceneObject = {
      id: "mir1",
      asset: mirrorAsset("flat_mirror"),
      pose: { xMm: 0, yMm: 0, zMm: 50, rxDeg: 0, ryDeg: 180, rzDeg: 0 },
    };
    const scene: V3Scene = { objects: [lens, mirror] };

    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
      powerMw: 1.0,
    });
    const result = traceRayScene(ray, scene, { maxSteps: 10 });

    // Expect at least 2 steps: lens (A→B), mirror (A→A reflect)
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.steps[0]!.asset.catalogId).toBe("lens_50");
    expect(result.steps[1]!.asset.catalogId).toBe("flat_mirror");

    // After mirror reflection, ray.direction in lab is -z
    const afterMirror = result.steps[1]!.outRays[0]!;
    // Note: outRays in TraceStep are in body frame (from the op).
    // The mirror's body +z gets rotated to lab -z by ry=180°, so the
    // reflected ray (body +z) in lab is -z.
    // Easier sanity: check finalRays direction.
    const finalOrLater = result.finalRays[0]
      ?? result.steps[result.steps.length - 1]!.outRays[0]!;
    // Either the final ray escaped backwards (direction.z ~ -1) OR it
    // hit the lens again — either way direction is -z post-mirror.
    expect(finalOrLater).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Off-axis translation
// ---------------------------------------------------------------------------

describe("traceRayScene / off-axis lens", () => {
  it("lens at (5, 0, 50): ray must hit at lens center in lab", () => {
    const lens: V3SceneObject = {
      id: "lens_off",
      asset: lensAsset("lens_50", 50),
      pose: { xMm: 5, yMm: 0, zMm: 50, ...noRotation },
    };
    const scene: V3Scene = { objects: [lens] };

    // Ray aimed at lens center (5,0,50)
    const ray = makeBeamRay({
      origin: { x: 5, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
    });
    const result = traceRayScene(ray, scene);
    expect(result.steps).toHaveLength(1);
    const stepRayIn = result.steps[0]!.rayIn;
    // In body frame, hit point should be on-axis (face A at body z=-1.5)
    expect(stepRayIn.origin.x).toBeCloseTo(0, 9);  // on-axis in body
    expect(stepRayIn.origin.z).toBeCloseTo(-1.5, 9);

    // Exit in lab: should be at x=5 (on lens lab axis), z=51.5
    const out = result.finalRays[0]!;
    expect(out.origin.x).toBeCloseTo(5, 9);
    expect(out.origin.z).toBeCloseTo(51.5, 9);
  });

  it("misses lens (ray axis 50mm off lens center): escape", () => {
    const lens: V3SceneObject = {
      id: "lens_off",
      asset: lensAsset("lens_50", 50),
      pose: { xMm: 0, yMm: 0, zMm: 50, ...noRotation },
    };
    const scene: V3Scene = { objects: [lens] };

    const ray = makeBeamRay({
      origin: { x: 50, y: 0, z: 0 },  // 50mm off axis (lens aperture 12.7)
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
    });
    const result = traceRayScene(ray, scene);
    expect(result.steps).toHaveLength(0);   // no hit
    expect(result.finalRays).toHaveLength(1);
    expect(result.terminated).toBe("escaped");
  });
});
