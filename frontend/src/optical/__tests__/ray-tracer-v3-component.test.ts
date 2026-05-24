/**
 * Phase 3c — Component binding tree tests.
 *
 * Verifies the (SceneObject → Component → Binding × N → Asset) chain
 * by exercising the v3 scene tracer on Components with multiple bindings,
 * combined with parent SceneObject pose transforms.
 *
 * Out of scope (Phase 4):
 *   - Jones binding-frame rotation (polarizers crossed inside a Component
 *     via binding rzDeg≠0 — would need the op to read binding rotation
 *     and project onto beam-local s/p)
 *   - Full IO-3 isolator behaviour (needs faraday_rotate op)
 */

import { describe, it, expect } from "vitest";

import "../kinds/lens/physics";
import "../kinds/mirror/physics";
import "../kinds/polarizer/physics";

import { makeBeamRay } from "../beam-ray";
import type { V3Pose } from "../pose";
import {
  type V3AssetSnapshot,
  type V3ComponentSnapshot,
  type V3Scene,
  flattenScene,
  traceRayScene,
} from "../ray-tracer-v3";

const noRot = { rxDeg: 0, ryDeg: 0, rzDeg: 0 };

const lensAsset = (cid: string, focalMm: number): V3AssetSnapshot => ({
  catalogId: cid,
  kind: "lens",
  faces: [
    { id: "A",
      positionMmBodyLocal: { x: 0, y: 0, z: -1.5 },
      normalBodyLocal: { x: 0, y: 0, z: -1 },
      apertureMm: 12.7, apertureShape: "circle" },
    { id: "B",
      positionMmBodyLocal: { x: 0, y: 0, z: 1.5 },
      normalBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 12.7, apertureShape: "circle" },
  ],
  transitions: [{ in: "A", out: "B", op: "abcd_thin_lens" }],
  defaultParams: { focalLengthMm: focalMm },
});

const mirrorAsset = (cid: string): V3AssetSnapshot => ({
  catalogId: cid,
  kind: "mirror",
  faces: [
    { id: "A",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      normalBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 12.7, apertureShape: "circle" },
  ],
  transitions: [{ in: "A", out: "A", op: "reflect_specular" }],
  defaultParams: { reflectivity: 1.0 },
});

// Mechanical asset — no kind, no faces, no transitions. Should be
// silently ignored by the tracer (no slot gets a hit because faces=[]).
const mechAsset = (cid: string): V3AssetSnapshot => ({
  catalogId: cid,
  kind: "mechanical",          // not in kind registry — but no faces → never hit
  faces: [],
  transitions: [],
  defaultParams: {},
});

// ---------------------------------------------------------------------------
// flattenScene
// ---------------------------------------------------------------------------

describe("flattenScene", () => {
  it("single-asset SceneObject → 1 slot, empty bindingId", () => {
    const scene: V3Scene = {
      objects: [{
        id: "so1",
        asset: lensAsset("l1", 50),
        pose: { xMm: 0, yMm: 0, zMm: 0, ...noRot },
      }],
    };
    const slots = flattenScene(scene);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.sceneObjectId).toBe("so1");
    expect(slots[0]!.bindingId).toBe("");
    expect(slots[0]!.asset.catalogId).toBe("l1");
  });

  it("component with 3 bindings → 3 slots, bindingIds preserved", () => {
    const component: V3ComponentSnapshot = {
      catalogId: "comp1",
      bindings: [
        { bindingId: "b1", asset: lensAsset("l_a", 30),
          localPose: { xMm: 0, yMm: 0, zMm: -10, ...noRot } },
        { bindingId: "b2", asset: lensAsset("l_b", 50),
          localPose: { xMm: 0, yMm: 0, zMm: 0, ...noRot } },
        { bindingId: "b3", asset: lensAsset("l_c", 80),
          localPose: { xMm: 0, yMm: 0, zMm: 10, ...noRot } },
      ],
    };
    const scene: V3Scene = {
      objects: [{
        id: "so1", component,
        pose: { xMm: 0, yMm: 0, zMm: 0, ...noRot },
      }],
    };
    const slots = flattenScene(scene);
    expect(slots).toHaveLength(3);
    expect(slots.map(s => s.bindingId)).toEqual(["b1", "b2", "b3"]);
    expect(slots.map(s => s.asset.catalogId)).toEqual(["l_a", "l_b", "l_c"]);
  });

  it("mixed scene: single-asset + component → flat slot list", () => {
    const scene: V3Scene = {
      objects: [
        { id: "single", asset: lensAsset("ll", 50),
          pose: { xMm: 0, yMm: 0, zMm: 0, ...noRot } },
        { id: "compSo", component: {
            catalogId: "comp",
            bindings: [
              { bindingId: "a", asset: lensAsset("la", 30),
                localPose: { xMm: 0, yMm: 0, zMm: 0, ...noRot } },
              { bindingId: "b", asset: lensAsset("lb", 60),
                localPose: { xMm: 0, yMm: 0, zMm: 5, ...noRot } },
            ],
          },
          pose: { xMm: 0, yMm: 0, zMm: 100, ...noRot } },
      ],
    };
    const slots = flattenScene(scene);
    expect(slots).toHaveLength(3);
    expect(slots[0]!.sceneObjectId).toBe("single");
    expect(slots[1]!.sceneObjectId).toBe("compSo");
    expect(slots[1]!.bindingId).toBe("a");
    expect(slots[2]!.bindingId).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// Trace through a component
// ---------------------------------------------------------------------------

describe("traceRayScene / component with 2 lenses", () => {
  it("ray hits both lenses in binding order; power preserved", () => {
    const stack: V3ComponentSnapshot = {
      catalogId: "stack_2_lenses",
      bindings: [
        { bindingId: "front", asset: lensAsset("front", 50),
          localPose: { xMm: 0, yMm: 0, zMm: -20, ...noRot } },
        { bindingId: "back", asset: lensAsset("back", 80),
          localPose: { xMm: 0, yMm: 0, zMm: 20, ...noRot } },
      ],
    };
    const scene: V3Scene = {
      objects: [{
        id: "so1", component: stack,
        pose: { xMm: 0, yMm: 0, zMm: 100, ...noRot },
      }],
    };
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
      powerMw: 1.0,
    });
    const result = traceRayScene(ray, scene, { maxSteps: 10 });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.asset.catalogId).toBe("front");
    expect(result.steps[1]!.asset.catalogId).toBe("back");

    // Lab position of front lens B face: 100 + (-20) + 1.5 = 81.5
    // Lab position of back lens B face:  100 + 20 + 1.5 = 121.5
    const out = result.finalRays[0]!;
    expect(out.origin.z).toBeCloseTo(121.5, 9);
    expect(out.powerMw).toBeCloseTo(1.0, 12);
  });
});

describe("traceRayScene / component with translated parent + rotated binding", () => {
  it("composes parent pose with binding pose correctly", () => {
    // Parent SceneObject at z=50 with no rotation.
    // Binding 1 (lens) at component-local z=-10 → lab z=40.
    // Binding 2 (mirror) at component-local z=+10 with ry=180 (face -z)
    //   → lab z=60, but ry=180 in project convention = Z(-180) → flips x,y
    //   leaves z normal direction unchanged.
    // For this test we just verify ray hits the lens then the mirror.
    const stack: V3ComponentSnapshot = {
      catalogId: "lens_mirror",
      bindings: [
        { bindingId: "lens", asset: lensAsset("l1", 50),
          localPose: { xMm: 0, yMm: 0, zMm: -10, ...noRot } },
        { bindingId: "mir", asset: mirrorAsset("m1"),
          localPose: { xMm: 0, yMm: 0, zMm: 10, ...noRot } },
      ],
    };
    const scene: V3Scene = {
      objects: [{
        id: "so1", component: stack,
        pose: { xMm: 0, yMm: 0, zMm: 50, ...noRot },
      }],
    };
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
    });
    const result = traceRayScene(ray, scene, { maxSteps: 10 });
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.steps[0]!.asset.catalogId).toBe("l1");
    expect(result.steps[1]!.asset.catalogId).toBe("m1");

    // After mirror reflection, ray.direction in lab is -z
    const out = result.finalRays[0]!;
    expect(out.direction.z).toBeCloseTo(-1, 12);
  });
});

describe("traceRayScene / mechanical binding ignored", () => {
  it("housing-only binding (no faces) does not block ray", () => {
    const component: V3ComponentSnapshot = {
      catalogId: "lens_in_housing",
      bindings: [
        { bindingId: "housing", asset: mechAsset("housing"),
          localPose: { xMm: 0, yMm: 0, zMm: 0, ...noRot } },
        { bindingId: "lens", asset: lensAsset("l1", 50),
          localPose: { xMm: 0, yMm: 0, zMm: 0, ...noRot } },
      ],
    };
    const scene: V3Scene = {
      objects: [{
        id: "so1", component,
        pose: { xMm: 0, yMm: 0, zMm: 0, ...noRot },
      }],
    };
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
    });
    const result = traceRayScene(ray, scene);
    // Only 1 step (lens). Housing has no faces, not hit.
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.asset.catalogId).toBe("l1");
  });
});

describe("traceRayScene / Jones binding rotation (Phase 4c)", () => {
  // Polarizer asset with transmission axis along body +x. Forward
  // transition only (A1 → B1). The binding rotates the polarizer
  // around the optical axis (lab Z), changing the LAB direction of
  // the transmission axis.
  const polarizerAsset = (): V3AssetSnapshot => ({
    catalogId: "pol_0deg",
    kind: "polarizer",
    faces: [
      { id: "A1", positionMmBodyLocal: { x: 0, y: 0, z: -1 },
        normalBodyLocal: { x: 0, y: 0, z: -1 },
        apertureMm: 6, apertureShape: "rectangle" },
      { id: "B1", positionMmBodyLocal: { x: 0, y: 0, z: 1 },
        normalBodyLocal: { x: 0, y: 0, z: 1 },
        apertureMm: 6, apertureShape: "rectangle" },
    ],
    transitions: [
      { in: "A1", out: "B1", op: "jones_polarizer" },
    ],
    defaultParams: { transmissionAxisDegBeamLocal: 0 },
  });

  it("polarizer at identity: +s input passes through", () => {
    const scene: V3Scene = {
      objects: [{
        id: "so1", asset: polarizerAsset(),
        pose: { xMm: 0, yMm: 0, zMm: 0, ...noRot },
      }],
    };
    const ray = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: -10 },
        direction: { x: 0, y: 0, z: 1 },
        wavelengthNm: 780, powerMw: 1.0,
      }),
      jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }] as [
        { re: number; im: number }, { re: number; im: number }
      ],
    };
    const result = traceRayScene(ray, scene);
    expect(result.finalRays[0]!.powerMw).toBeCloseTo(1.0, 12);
  });

  // ryDeg = -45 in project's Euler convention = Three Z angle +45 =
  // Rz(+45) — rotates body +x to (cos45, sin45, 0) in lab. The
  // polarizer's body-frame transmission axis (along body +x, beam-local +s
  // in body) thus maps to lab (cos45, sin45, 0). A lab-frame +x polarized
  // ray hits the polarizer with polarization 45° off transmission axis,
  // giving cos²(45) = 0.5 transmission.
  it("polarizer rotated 45° around optical axis: lab +x → Malus 0.5", () => {
    const scene: V3Scene = {
      objects: [{
        id: "so1", asset: polarizerAsset(),
        pose: { xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: -45, rzDeg: 0 },
      }],
    };
    const ray = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: -10 },
        direction: { x: 0, y: 0, z: 1 },
        wavelengthNm: 780, powerMw: 1.0,
      }),
      // pure +s in lab = lab +x polarization (beam direction is +z and
      // global up = +z fallback gives s = +x)
      jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }] as [
        { re: number; im: number }, { re: number; im: number }
      ],
    };
    const result = traceRayScene(ray, scene);
    expect(result.finalRays[0]!.powerMw).toBeCloseTo(0.5, 9);
  });

  it("polarizer rotated 90° around optical axis: lab +x → blocked", () => {
    const scene: V3Scene = {
      objects: [{
        id: "so1", asset: polarizerAsset(),
        pose: { xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: -90, rzDeg: 0 },
      }],
    };
    const ray = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: -10 },
        direction: { x: 0, y: 0, z: 1 },
        wavelengthNm: 780, powerMw: 1.0,
      }),
      jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }] as [
        { re: number; im: number }, { re: number; im: number }
      ],
    };
    const result = traceRayScene(ray, scene);
    expect(result.finalRays[0]!.powerMw).toBeCloseTo(0, 9);
  });
});

describe("traceRayScene / excludeFaceKey is binding-scoped", () => {
  it("ray exiting lens binding can still hit a second lens binding in same component", () => {
    // Two lenses in a single Component. Each has face id "A" and "B".
    // After exiting lens1.B, the excludeFaceKey is scoped to lens1,
    // so when the ray approaches lens2.A it gets hit normally (not
    // accidentally excluded just because the face id is "A").
    const stack: V3ComponentSnapshot = {
      catalogId: "two_lens",
      bindings: [
        { bindingId: "l1", asset: lensAsset("l1", 50),
          localPose: { xMm: 0, yMm: 0, zMm: 0, ...noRot } },
        { bindingId: "l2", asset: lensAsset("l2", 80),
          localPose: { xMm: 0, yMm: 0, zMm: 20, ...noRot } },
      ],
    };
    const scene: V3Scene = {
      objects: [{
        id: "so1", component: stack,
        pose: { xMm: 0, yMm: 0, zMm: 0, ...noRot },
      }],
    };
    const ray = makeBeamRay({
      origin: { x: 0, y: 0, z: -10 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
    });
    const result = traceRayScene(ray, scene, { maxSteps: 10 });
    expect(result.steps).toHaveLength(2);
    // Lens 1 binding "l1" hit first, then lens 2 binding "l2"
    expect(result.steps[0]!.asset.catalogId).toBe("l1");
    expect(result.steps[1]!.asset.catalogId).toBe("l2");
  });
});
