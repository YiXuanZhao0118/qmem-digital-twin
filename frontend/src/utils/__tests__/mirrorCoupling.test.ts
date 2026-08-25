/**
 * Two-mirror coupling geometry.
 *
 * The invariant every test here defends: after the plan is applied, BOTH
 * mirrors sit at exactly 45 deg to their legs, the beam crosses each mirror
 * at its centre (zero decentre), and the outgoing ray is the destination
 * port's own axis. Nothing is iterated — if a case comes out wrong it is the
 * closed form that is wrong.
 *
 * `agrees with the backend tracer` is the load-bearing one: it pins
 * `anchorPose.resolveAnchorPosesLab` (binding XYZ Euler, then the
 * SceneObject's YXZ-remapped convention) against numbers the Python solver
 * produced for the live scene. Get that composition wrong and every pose this
 * module emits lands somewhere the tracer disagrees with.
 */
import { describe, expect, it } from "vitest";

import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  SceneData,
  SceneObject,
} from "../../types/digitalTwin";
import { resolveAnchorPosesLab } from "../anchorPose";
import {
  checkMirrorTouch,
  intersectMirror,
  isSolveError,
  mirrorFactsFromObject,
  planMirrorCoupling,
  poseMirrorTo,
  reflect,
  solveCouplingGeometry,
  type MirrorFacts,
  type Ray,
  type Vec3,
} from "../mirrorCoupling";

// ─── fixtures: a BB1-E03-shaped mirror ─────────────────────────────────────
//
// Matches the live catalog row: one asset whose `intercept_face` sits at the
// asset origin with axisX = +Z, bound into the Component with localRx = -90
// (so the face normal is +Y in the Component CAD frame, which is what the
// mirror Component's alignSpec.directionMm records).

const ROOT2 = Math.SQRT1_2;

function mirrorAsset(id = "asset-mirror"): Asset3D {
  return {
    id,
    name: "BB1-E03-Step",
    kindId: "mirror",
    filePath: "bb1_e03_step.glb",
    anchors: [
      {
        id: "intercept_face",
        positionMmBodyLocal: { x: 0, y: 0, z: 0 },
        axisXBodyLocal: { x: 0, y: 0, z: 1 },
        axisYBodyLocal: { x: 0, y: 1, z: 0 },
        axisZBodyLocal: { x: -1, y: 0, z: 0 },
        apertureMm: 12.7,
        apertureShape: "circle",
      },
    ],
  } as unknown as Asset3D;
}

function mirrorScene(objects: SceneObject[]): Pick<
  SceneData,
  "componentBindings" | "objectBindings" | "assets" | "components"
> & { objects: SceneObject[] } {
  const component = {
    id: "comp-mirror",
    name: "Opt Mirror",
    kindId: "mirror",
    asset3dId: null,
  } as unknown as ComponentItem;
  const binding = {
    id: "bind-mirror",
    componentId: "comp-mirror",
    parentBindingId: null,
    targetKind: "asset",
    asset3dId: "asset-mirror",
    subComponentId: null,
    role: "BB1-E03-Step",
    localXMm: 0,
    localYMm: 0,
    localZMm: 0,
    localRxDeg: -90,
    localRyDeg: 0,
    localRzDeg: 0,
    sortOrder: 0,
  } as unknown as ComponentBinding;
  return {
    components: [component],
    assets: [mirrorAsset()],
    componentBindings: [binding],
    objectBindings: [],
    objects,
  };
}

function mirrorObject(id: string, pose: Partial<SceneObject>): SceneObject {
  return {
    id,
    name: id,
    componentId: "comp-mirror",
    xMm: 0,
    yMm: 0,
    zMm: 0,
    rxDeg: 0,
    ryDeg: 0,
    rzDeg: 0,
    locked: false,
    visible: true,
    properties: {},
    ...pose,
  } as unknown as SceneObject;
}

function facts(id: string, pose: Partial<SceneObject>): MirrorFacts {
  const obj = mirrorObject(id, pose);
  const scene = mirrorScene([obj]);
  const f = mirrorFactsFromObject(obj, scene);
  if (isSolveError(f)) throw new Error(f.error);
  return f;
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** AOI in degrees between a propagation direction and a surface normal. */
const aoi = (d: Vec3, n: Vec3): number =>
  (Math.acos(Math.min(1, Math.abs(dot(d, n)))) * 180) / Math.PI;

// ─── the solve ─────────────────────────────────────────────────────────────

describe("solveCouplingGeometry", () => {
  it("has a unique answer when the input and target are not collinear", () => {
    const g = solveCouplingGeometry({
      inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) },
      targetRay: { origin: v(100, 50, 20), dir: v(0, 1, 0) },
      // Current poses are irrelevant in this branch — deliberately absurd.
      currentA: v(-999, -999, -999),
      currentB: v(999, 999, 999),
    });
    if (isSolveError(g)) throw new Error(g.error);

    expect(g.freeDof).toBe(false);
    expect(g.centreA.x).toBeCloseTo(100, 9);
    expect(g.centreA.y).toBeCloseTo(0, 9);
    expect(g.centreA.z).toBeCloseTo(0, 9);
    expect(g.centreB.x).toBeCloseTo(100, 9);
    expect(g.centreB.y).toBeCloseTo(0, 9);
    expect(g.centreB.z).toBeCloseTo(20, 9);
    expect(g.legLengthMm).toBeCloseTo(20, 9);
    // Mirror B upstream of the port, mirror A downstream of the source.
    expect(g.targetStandoffMm).toBeCloseTo(-50, 9);
    expect(g.foldMm).toBeCloseTo(100, 9);
    expect(g.warnings).toEqual([]);
  });

  it("reflects the input onto the target through both 45 deg mirrors", () => {
    const inDir = v(1, 0, 0);
    const tgtDir = { x: 0, y: 0.6, z: 0.8 };
    const g = solveCouplingGeometry({
      inRay: { origin: v(0, 0, 0), dir: inDir },
      targetRay: { origin: v(80, 40, -25), dir: tgtDir },
      currentA: v(0, 0, 0),
      currentB: v(0, 0, 0),
    });
    if (isSolveError(g)) throw new Error(g.error);

    expect(aoi(inDir, g.normalA)).toBeCloseTo(45, 9);
    const mid = reflect(inDir, g.normalA);
    expect(dist(mid, g.d1)).toBeCloseTo(0, 9);
    expect(aoi(g.d1, g.normalB)).toBeCloseTo(45, 9);
    const out = reflect(g.d1, g.normalB);
    expect(out.x).toBeCloseTo(tgtDir.x, 9);
    expect(out.y).toBeCloseTo(tgtDir.y, 9);
    expect(out.z).toBeCloseTo(tgtDir.z, 9);
  });

  it("leaves one free DOF when the input and target are anti-parallel (a U-turn)", () => {
    // The live DBR -> TA path: MIRROR5 folds the beam to -Y, MIRROR7 and
    // MIRROR8 turn it back to +Y and into the TA, 37.49 mm across.
    const pIn = v(-298.9266, -453.519, 908.8317);
    const pTgt = v(-261.435, -363.323, 908.8317);
    const curA = v(-297.4142, -489.1494, 909.7603); // MIRROR7 face centre
    const curB = v(-261.0181, -487.4298, 908.8317); // MIRROR8 face centre

    const g = solveCouplingGeometry({
      inRay: { origin: pIn, dir: v(0, -1, 0) },
      targetRay: { origin: pTgt, dir: v(0, 1, 0) },
      currentA: curA,
      currentB: curB,
    });
    if (isSolveError(g)) throw new Error(g.error);

    expect(g.freeDof).toBe(true);
    // d1 is still pinned — it is the perpendicular offset between the two
    // parallel lines, whatever the slide parameter does.
    expect(g.d1.x).toBeCloseTo(1, 9);
    expect(g.d1.y).toBeCloseTo(0, 9);
    expect(g.d1.z).toBeCloseTo(0, 9);
    expect(g.legLengthMm).toBeCloseTo(37.4916, 3);
    // Least-travel default for the slide.
    expect(g.foldMm).toBeCloseTo(34.7706, 3);
    expect(g.centreA.y).toBeCloseTo(-488.2896, 3);
    expect(g.centreB.y).toBeCloseTo(-488.2896, 3);
    expect(g.centreA.x).toBeCloseTo(-298.9266, 4);
    expect(g.centreB.x).toBeCloseTo(-261.435, 4);
    // The normals the live scene already has, recovered from scratch.
    expect(g.normalA.x).toBeCloseTo(ROOT2, 6);
    expect(g.normalA.y).toBeCloseTo(ROOT2, 6);
    expect(g.normalB.x).toBeCloseTo(-ROOT2, 6);
    expect(g.normalB.y).toBeCloseTo(ROOT2, 6);
  });

  it("sliding the free DOF moves both mirrors together and keeps the leg", () => {
    const base = {
      inRay: { origin: v(0, 0, 0), dir: v(0, -1, 0) },
      targetRay: { origin: v(30, 100, 0), dir: v(0, 1, 0) },
      currentA: v(0, -50, 0),
      currentB: v(30, -50, 0),
    };
    const a = solveCouplingGeometry(base);
    const b = solveCouplingGeometry({ ...base, foldMm: 75 });
    if (isSolveError(a) || isSolveError(b)) throw new Error("unexpected solve error");

    expect(a.foldMm).toBeCloseTo(50, 9);
    expect(b.foldMm).toBeCloseTo(75, 9);
    expect(b.centreA.y).toBeCloseTo(-75, 9);
    expect(b.centreB.y).toBeCloseTo(-75, 9);
    expect(b.legLengthMm).toBeCloseTo(a.legLengthMm, 9);
    expect(b.normalA).toEqual(a.normalA);
    expect(b.normalB).toEqual(a.normalB);
  });

  it("handles a periscope (input and target parallel, offset)", () => {
    const g = solveCouplingGeometry({
      inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) },
      targetRay: { origin: v(200, 0, 30), dir: v(1, 0, 0) },
      currentA: v(50, 0, 0),
      currentB: v(50, 0, 30),
    });
    if (isSolveError(g)) throw new Error(g.error);

    expect(g.freeDof).toBe(true);
    expect(g.legLengthMm).toBeCloseTo(30, 9);
    expect(g.centreA).toEqual(expect.objectContaining({ z: 0 }));
    expect(g.centreB.z).toBeCloseTo(30, 9);
    expect(aoi(v(1, 0, 0), g.normalA)).toBeCloseTo(45, 9);
    expect(aoi(g.d1, g.normalB)).toBeCloseTo(45, 9);
  });

  it("refuses when the input beam is already on the target axis", () => {
    const g = solveCouplingGeometry({
      inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) },
      targetRay: { origin: v(500, 0, 0), dir: v(1, 0, 0) },
      currentA: v(100, 0, 0),
      currentB: v(200, 0, 0),
    });
    expect(isSolveError(g)).toBe(true);
  });

  it("warns rather than silently emitting a backwards layout", () => {
    // Target port sits UPSTREAM of where mirror B has to be.
    const g = solveCouplingGeometry({
      inRay: { origin: v(0, 0, 0), dir: v(1, 0, 0) },
      targetRay: { origin: v(100, 50, 20), dir: v(0, -1, 0) },
      currentA: v(0, 0, 0),
      currentB: v(0, 0, 0),
    });
    if (isSolveError(g)) throw new Error(g.error);
    expect(g.warnings.join(" ")).toMatch(/PAST the destination port/);
  });
});

// ─── pose synthesis ────────────────────────────────────────────────────────

describe("poseMirrorTo", () => {
  it("lands the face centre on the point with the normal on the direction", () => {
    const m = facts("M", { xMm: 10, yMm: -20, zMm: 5, rxDeg: 45, ryDeg: -90, rzDeg: 0 });
    const centre = v(-100, 33, 907);
    const normal = v(ROOT2, 0, ROOT2);

    const move = poseMirrorTo(m, centre, normal);
    const moved = mirrorObject("M", move.pose);
    const [resolved] = resolveAnchorPosesLab(
      mirrorScene([moved]).components[0],
      moved,
      mirrorScene([moved]),
    );

    expect(resolved.posLab.x).toBeCloseTo(centre.x, 9);
    expect(resolved.posLab.y).toBeCloseTo(centre.y, 9);
    expect(resolved.posLab.z).toBeCloseTo(centre.z, 9);
    expect(resolved.axisXLab!.x).toBeCloseTo(normal.x, 9);
    expect(resolved.axisXLab!.y).toBeCloseTo(normal.y, 9);
    expect(resolved.axisXLab!.z).toBeCloseTo(normal.z, 9);
  });

  it("uses the SHORTEST rotation, so a mirror already aimed right is not spun", () => {
    const m = facts("M", { xMm: 1, yMm: 2, zMm: 3, rxDeg: -45, ryDeg: -90, rzDeg: 0 });
    const move = poseMirrorTo(m, v(50, 60, 70), m.normalLab);

    expect(move.rotationDeg).toBeCloseTo(0, 9);
    expect(move.pose.rxDeg).toBeCloseTo(-45, 6);
    expect(move.pose.ryDeg).toBeCloseTo(-90, 6);
    expect(move.pose.rzDeg).toBeCloseTo(0, 6);
    expect(move.travelMm).toBeCloseTo(dist(v(50, 60, 70), m.centreLab), 9);
  });
});

// ─── the precondition ──────────────────────────────────────────────────────

describe("checkMirrorTouch", () => {
  /** A U-turn pair matching the live layout, but exactly aligned. */
  const alignedPair = () => ({
    a: facts("A", { xMm: 0, yMm: -100, zMm: 0, rxDeg: -45, ryDeg: -90, rzDeg: 0 }),
    b: facts("B", { xMm: 40, yMm: -100, zMm: 0, rxDeg: 45, ryDeg: -90, rzDeg: 0 }),
    inRay: { origin: v(0, 0, 0), dir: v(0, -1, 0) } as Ray,
    targetRay: { origin: v(40, 0, 0), dir: v(0, 1, 0) } as Ray,
  });

  it("passes when both beams touch both mirrors", () => {
    const { a, b, inRay, targetRay } = alignedPair();
    // Sanity: the fixture really does fold +X then +Y.
    expect(reflect(inRay.dir, a.normalLab).x).toBeCloseTo(1, 9);

    const t = checkMirrorTouch({ inRay, targetRay, a, b });
    expect(t.failures).toEqual([]);
    expect(t.ok).toBe(true);
    expect(t.seedOnA!.decentreMm).toBeCloseTo(0, 9);
    expect(t.seedOnB!.decentreMm).toBeCloseTo(0, 9);
    expect(t.targetOnB!.decentreMm).toBeCloseTo(0, 9);
    expect(t.targetOnA!.decentreMm).toBeCloseTo(0, 9);
  });

  it("still passes when the mirrors are merely a little off", () => {
    const { b, inRay, targetRay } = alignedPair();
    const a = facts("A", { xMm: 1.5, yMm: -101, zMm: 0.9, rxDeg: -45, ryDeg: -90, rzDeg: 0 });
    const t = checkMirrorTouch({ inRay, targetRay, a, b });
    expect(t.ok).toBe(true);
    expect(t.seedOnA!.decentreMm).toBeGreaterThan(0.5);
  });

  it("names the mirror and the miss when a beam falls off the optic", () => {
    const { b, inRay, targetRay } = alignedPair();
    const a = facts("A", { xMm: 0, yMm: -100, zMm: 60, rxDeg: -45, ryDeg: -90, rzDeg: 0 });
    const t = checkMirrorTouch({ inRay, targetRay, a, b });

    expect(t.ok).toBe(false);
    expect(t.failures.join(" ")).toMatch(/Seed beam misses A by/);
  });
});

// ─── end to end ────────────────────────────────────────────────────────────

describe("planMirrorCoupling", () => {
  it("drives decentre and target miss to zero", () => {
    const a = facts("A", { xMm: 1.5, yMm: -101, zMm: 0.9, rxDeg: -45, ryDeg: -90, rzDeg: 0 });
    const b = facts("B", { xMm: 40.4, yMm: -99.2, zMm: 0, rxDeg: 45, ryDeg: -90, rzDeg: 0 });
    const inRay: Ray = { origin: v(0, 0, 0), dir: v(0, -1, 0) };
    const targetRay: Ray = { origin: v(40, 0, 0), dir: v(0, 1, 0) };

    const plan = planMirrorCoupling({ inRay, targetRay, a, b });
    if (isSolveError(plan)) throw new Error(plan.error);
    expect(plan.beforeTargetMissMm).toBeGreaterThan(0.1);

    // Re-resolve both mirrors from the poses the plan produced and re-run
    // the whole check against them.
    const movedA = mirrorObject("A", plan.moveA.pose);
    const movedB = mirrorObject("B", plan.moveB.pose);
    const sceneA = mirrorScene([movedA]);
    const sceneB = mirrorScene([movedB]);
    const fa = mirrorFactsFromObject(movedA, sceneA);
    const fb = mirrorFactsFromObject(movedB, sceneB);
    if (isSolveError(fa) || isSolveError(fb)) throw new Error("re-resolve failed");

    const after = checkMirrorTouch({ inRay, targetRay, a: fa, b: fb });
    expect(after.ok).toBe(true);
    expect(after.seedOnA!.decentreMm).toBeCloseTo(0, 6);
    expect(after.seedOnB!.decentreMm).toBeCloseTo(0, 6);
    expect(after.seedOnA!.aoiDeg).toBeCloseTo(45, 6);
    expect(after.seedOnB!.aoiDeg).toBeCloseTo(45, 6);

    const outAfterA = reflect(inRay.dir, fa.normalLab);
    const hitB = intersectMirror({ origin: after.seedOnA!.pointLab, dir: outAfterA }, fb)!;
    const outFinal = reflect(outAfterA, fb.normalLab);
    expect(outFinal.y).toBeCloseTo(1, 6);
    // On the target axis, not merely parallel to it.
    expect(hitB.pointLab.x).toBeCloseTo(targetRay.origin.x, 6);
    expect(hitB.pointLab.z).toBeCloseTo(targetRay.origin.z, 6);
  });
});

// ─── the backend agreement pin ─────────────────────────────────────────────

describe("anchorPose agrees with the backend tracer", () => {
  /**
   * MIRROR5 from the live scene. `/api/v3/solver/run-from-db` reports the
   * beam arriving along +X and leaving along -Y, crossing the mirror at
   * (-298.93, -453.52, 908.83). Both the crossing point and the reflected
   * direction are backend outputs, so reproducing them here pins the whole
   * frontend composition: the binding's raw XYZ Euler AND the SceneObject's
   * YXZ-remapped rotation convention.
   */
  it("reproduces MIRROR5's traced face centre and reflection", () => {
    const obj = mirrorObject("MIRROR5", {
      xMm: -298.926606,
      yMm: -453.518962,
      zMm: 908.83165,
      rxDeg: 135,
      ryDeg: -90,
      rzDeg: 0,
    });
    const scene = mirrorScene([obj]);
    const f = mirrorFactsFromObject(obj, scene);
    if (isSolveError(f)) throw new Error(f.error);

    expect(f.centreLab.x).toBeCloseTo(-298.93, 2);
    expect(f.centreLab.y).toBeCloseTo(-453.52, 2);
    expect(f.centreLab.z).toBeCloseTo(908.83, 2);
    expect(f.apertureMm).toBe(12.7);

    const out = reflect(v(1, 0, 0), f.normalLab);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(-1, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });

  it("reproduces MIRROR7 and MIRROR8's 45 deg normals", () => {
    const m7 = facts("MIRROR7", {
      xMm: -297.414177, yMm: -489.149399, zMm: 909.760341,
      rxDeg: -45, ryDeg: -90, rzDeg: 0,
    });
    const m8 = facts("MIRROR8", {
      xMm: -261.018145, yMm: -487.429769, zMm: 908.83165,
      rxDeg: 45, ryDeg: -90, rzDeg: 0,
    });
    // -Y in, +X out at MIRROR7; +X in, +Y out at MIRROR8.
    const afterM7 = reflect(v(0, -1, 0), m7.normalLab);
    expect(afterM7.x).toBeCloseTo(1, 9);
    const afterM8 = reflect(v(1, 0, 0), m8.normalLab);
    expect(afterM8.y).toBeCloseTo(1, 9);
  });
});
