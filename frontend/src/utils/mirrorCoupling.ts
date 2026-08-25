/**
 * Two-mirror coupling — "put MIRROR_A and MIRROR_B where the beam leaves the
 * upstream optic at 45 deg on each mirror, centred on each mirror, and lands
 * exactly on a destination port's axis".
 *
 * The classic bench problem: a seed beam has to be walked into a TA / fibre /
 * cavity with two steering mirrors. Here it is solved in closed form rather
 * than by iterating knobs, because the digital twin can move a mount as
 * freely as it can turn it.
 *
 * ── The geometry ──────────────────────────────────────────────────────────
 *
 * Given the input line L_in = (P_in, d0) and the target line
 * L_tgt = (P_tgt, dT) — dT points INTO the destination — write the middle leg
 * direction d1. Both mirrors at exactly 45 deg means each reflection turns
 * the beam by 90 deg:
 *
 *     d1 . d0 = 0    and    d1 . dT = 0
 *
 * and the reflection law then fixes both normals with no freedom left:
 *
 *     nA = unit(d1 - d0)        nB = unit(dT - d1)
 *
 * "Spot centred on the mirror" means the mirror centres sit ON the rays:
 * C_A in L_in, C_B in L_tgt, with C_B - C_A parallel to d1. How many
 * solutions that has depends only on d0 vs dT:
 *
 *   |d0 x dT| > 0   (generic)   d1 = unit(d0 x dT); C_A, C_B follow from a
 *                               2x2 solve. UNIQUE.
 *   d0 = +-dT       (collinear) A U-turn (the common case on a bench) or a
 *                               periscope. d1 is still pinned — it must be
 *                               the perpendicular offset between the two
 *                               parallel lines — but the pair can SLIDE
 *                               along d0 together. ONE FREE DOF, exposed as
 *                               `foldMm` and defaulted to least travel.
 *   collinear and the two lines coincide  ->  no solution (reported).
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 *
 * A layout solver, not a knob simulator. A real mount is bolted down and only
 * offers tip/tilt; those 4 DOF can hit the target line but cannot also hold
 * 45 deg and a centred spot. This answers "where should the mounts be", which
 * is what the twin is for. A rotation-only "walk the beam" mode would be a
 * separate solver.
 *
 * 45/45 is deliberately fixed. With both angles free the middle direction
 * lies on a cone and the problem stops being well-posed.
 *
 * Frames: everything below is raw Z-up lab mm, matching TA / AOM / isolator
 * align (`labDirToThreeLocal` is identity), so a decomposed Euler is a plain
 * SceneObject pose. Mirror centres / normals come from `anchorPose.ts`.
 */
import * as THREE from "three";

import type { ComponentItem, SceneData, SceneObject } from "../types/digitalTwin";
import {
  labDirToThreeLocal,
  sceneObjectEulerFromQuaternion,
  sceneObjectToQuaternion,
} from "../optical/frames";
import { resolveAnchorPosesLab, type AnchorPoseLab } from "./anchorPose";
import type { AlignPose, Vec3 } from "./isolatorAlign";

export type { AlignPose, Vec3 };

/** The reflective-face anchor every `mirror` / `dichroic_mirror` asset
 *  carries (see the `mirror` plugin's role map). */
export const MIRROR_FACE_ANCHOR_ID = "intercept_face";

/** Clear-aperture RADIUS used when a mirror asset declares none. A 1/2"
 *  optic — deliberately the small end, so a missing aperture makes the
 *  touch test STRICTER rather than waving a miss through. */
export const DEFAULT_MIRROR_APERTURE_MM = 6.35;

/** |d0 x dT| below this counts as collinear (the 1-free-DOF branch).
 *  1e-6 is ~0.00006 deg — far below any pose the authoring UI can express. */
const COLLINEAR_SIN_EPS = 1e-6;

/** A perpendicular offset smaller than this makes the two collinear lines
 *  effectively coincident, and d1 undefined. */
const MIN_PERP_OFFSET_MM = 1e-3;

export type Ray = {
  /** Any point on the line, lab mm. */
  origin: Vec3;
  /** Propagation direction, lab, unit (normalised on entry). */
  dir: Vec3;
};

/** Everything the solver needs to know about one mirror. */
export type MirrorFacts = {
  objectId: string;
  name: string;
  sceneObject: SceneObject;
  /** Reflective-face centre in the Component CAD frame (mm). */
  centreCad: Vec3;
  /** Outward face normal in the Component CAD frame, unit. */
  normalCad: Vec3;
  /** Reflective-face centre in lab mm — the "mirror centre" the spot has
   *  to land on. */
  centreLab: Vec3;
  /** Outward face normal in lab, unit. */
  normalLab: Vec3;
  /** Clear-aperture RADIUS in mm (backend semantics: `r > aperture` misses). */
  apertureMm: number;
};

// ─── small vector helpers (lab mm, plain objects) ──────────────────────────

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export function unitOrNull(v: Vec3): Vec3 | null {
  const m = len(v);
  return m < 1e-12 ? null : { x: v.x / m, y: v.y / m, z: v.z / m };
}

function unitOrThrow(v: Vec3): Vec3 {
  const u = unitOrNull(v);
  if (!u) throw new Error("mirrorCoupling: degenerate vector");
  return u;
}

/** Normalise a ray's direction. Returns null for a zero direction. */
export function normaliseRay(r: Ray): Ray | null {
  const d = unitOrNull(r.dir);
  return d ? { origin: r.origin, dir: d } : null;
}

/** Ideal reflection off a plane with unit normal `n`. */
export function reflect(d: Vec3, n: Vec3): Vec3 {
  return sub(d, mul(n, 2 * dot(d, n)));
}

// ─── mirror facts ──────────────────────────────────────────────────────────

type SceneSlice = Pick<
  SceneData,
  "componentBindings" | "objectBindings" | "assets" | "components"
>;

/** Resolve one SceneObject into `MirrorFacts`, or a reason it can't be one.
 *  The mirror must expose an `intercept_face` anchor with a direction —
 *  without a normal the tracer would not know which side reflects, so a
 *  mirror lacking it is broken data, not a solver limitation. */
export function mirrorFactsFromObject(
  sceneObject: SceneObject,
  scene: SceneSlice,
): MirrorFacts | { error: string } {
  const component: ComponentItem | undefined = (scene.components ?? []).find(
    (c) => c.id === sceneObject.componentId,
  );
  if (!component) return { error: `${sceneObject.name}: Component row not in the scene store.` };

  const anchors = resolveAnchorPosesLab(component, sceneObject, scene);
  const face: AnchorPoseLab | undefined = anchors.find((a) => a.anchorId === MIRROR_FACE_ANCHOR_ID);
  if (!face) {
    return { error: `${sceneObject.name}: no \`${MIRROR_FACE_ANCHOR_ID}\` anchor in its binding tree.` };
  }
  if (!face.axisXLab || !face.axisXCad) {
    return {
      error:
        `${sceneObject.name}: \`${MIRROR_FACE_ANCHOR_ID}\` declares no direction. `
        + "Set the face normal (axisX) in PHY Editor -> Optical.",
    };
  }
  return {
    objectId: sceneObject.id,
    name: sceneObject.name,
    sceneObject,
    centreCad: face.posCad,
    normalCad: face.axisXCad,
    centreLab: face.posLab,
    normalLab: face.axisXLab,
    apertureMm: face.apertureMm ?? DEFAULT_MIRROR_APERTURE_MM,
  };
}

// ─── the touch test (the feature's precondition) ───────────────────────────

/** One ray meeting one mirror plane. */
export type SpotHit = {
  /** Lab point where the ray crosses the mirror's plane. */
  pointLab: Vec3;
  /** Distance from that point to the mirror centre (mm) — the spot
   *  decentre the feature drives to zero. */
  decentreMm: number;
  /** Parametric distance along the ray. Negative = the plane is behind the
   *  ray's origin. */
  tMm: number;
  /** Within the clear-aperture radius. */
  inAperture: boolean;
  /** The ray approaches the reflective side (d . n < 0). */
  frontSide: boolean;
  /** Angle of incidence from the surface normal, degrees. */
  aoiDeg: number;
};

/** Intersect a ray with a mirror's plane. null when the ray runs parallel
 *  to the plane. Mirrors the backend `intersect_anchor` geometry (offsets
 *  measured in the anchor plane, circular clear aperture of RADIUS
 *  `aperture_mm`), except that `t` is returned signed instead of rejected,
 *  so the UI can say "behind you" rather than just "no hit". */
export function intersectMirror(ray: Ray, m: MirrorFacts): SpotHit | null {
  const n = m.normalLab;
  const denom = dot(ray.dir, n);
  if (Math.abs(denom) < 1e-12) return null;
  const t = dot(sub(m.centreLab, ray.origin), n) / denom;
  const pointLab = add(ray.origin, mul(ray.dir, t));
  const decentreMm = len(sub(pointLab, m.centreLab));
  return {
    pointLab,
    decentreMm,
    tMm: t,
    inAperture: decentreMm <= m.apertureMm + 1e-9,
    frontSide: denom < 0,
    aoiDeg: (Math.acos(Math.min(1, Math.abs(denom))) * 180) / Math.PI,
  };
}

export type TouchMatrix = {
  /** Seed beam (upstream side) on mirror A, then its reflection on B. */
  seedOnA: SpotHit | null;
  seedOnB: SpotHit | null;
  /** Reverse reference ray from the destination port on mirror B, then its
   *  reflection on A. This is the virtual counterpart of shining the TA's
   *  own light backwards down the path to check overlap — the standard
   *  bench procedure, and the reason the precondition is "both mirrors are
   *  touched by BOTH beams". */
  targetOnB: SpotHit | null;
  targetOnA: SpotHit | null;
  /** All four cells landed inside their mirror's clear aperture, in front
   *  of the ray origin. */
  ok: boolean;
  /** One line per failing cell, ready to show. */
  failures: string[];
};

/** Evaluate the 2x2 precondition using the mirrors' CURRENT poses. */
export function checkMirrorTouch(args: {
  inRay: Ray;
  targetRay: Ray;
  a: MirrorFacts;
  b: MirrorFacts;
}): TouchMatrix {
  const { inRay, targetRay, a, b } = args;
  const failures: string[] = [];

  const grade = (hit: SpotHit | null, mirror: MirrorFacts, label: string): SpotHit | null => {
    if (!hit) {
      failures.push(`${label} runs parallel to ${mirror.name} — no crossing.`);
      return null;
    }
    if (hit.tMm <= 0) {
      failures.push(`${label} crosses ${mirror.name}'s plane behind its start point.`);
    } else if (!hit.inAperture) {
      failures.push(
        `${label} misses ${mirror.name} by ${hit.decentreMm.toFixed(1)} mm `
        + `(clear aperture ${mirror.apertureMm.toFixed(1)} mm radius).`,
      );
    }
    return hit;
  };

  const seedOnA = grade(intersectMirror(inRay, a), a, "Seed beam");
  let seedOnB: SpotHit | null = null;
  if (seedOnA && seedOnA.tMm > 0) {
    const afterA: Ray = { origin: seedOnA.pointLab, dir: reflect(inRay.dir, a.normalLab) };
    seedOnB = grade(intersectMirror(afterA, b), b, "Seed beam after " + a.name);
  }

  const reverse: Ray = { origin: targetRay.origin, dir: mul(targetRay.dir, -1) };
  const targetOnB = grade(intersectMirror(reverse, b), b, "Reverse reference ray");
  let targetOnA: SpotHit | null = null;
  if (targetOnB && targetOnB.tMm > 0) {
    const afterB: Ray = { origin: targetOnB.pointLab, dir: reflect(reverse.dir, b.normalLab) };
    targetOnA = grade(intersectMirror(afterB, a), a, "Reverse reference ray after " + b.name);
  }

  const good = (h: SpotHit | null): boolean => !!h && h.tMm > 0 && h.inAperture;
  return {
    seedOnA,
    seedOnB,
    targetOnB,
    targetOnA,
    ok: good(seedOnA) && good(seedOnB) && good(targetOnB) && good(targetOnA),
    failures,
  };
}

// ─── the geometry solve ────────────────────────────────────────────────────

export type CouplingGeometry = {
  /** Middle leg direction (A -> B), unit. */
  d1: Vec3;
  centreA: Vec3;
  centreB: Vec3;
  /** Outward face normals, unit. 45 deg to both legs by construction. */
  normalA: Vec3;
  normalB: Vec3;
  legLengthMm: number;
  /** True when L_in and L_tgt are collinear, so `foldMm` is a real degree of
   *  freedom the caller may sweep. False when the solution is unique and
   *  `foldMm` is merely reported. */
  freeDof: boolean;
  /** Signed distance of centreA from the input ray's origin, along d0. Also
   *  the free parameter in the collinear branch. */
  foldMm: number;
  /** Signed distance of centreB from the destination anchor along dT.
   *  Negative = B sits upstream of the port, which is what you want. */
  targetStandoffMm: number;
  /** Non-fatal notes (mirror bodies close enough to foul, B downstream of
   *  the port, A upstream of the source). */
  warnings: string[];
};

export type SolveError = { error: string };

export function isSolveError<T>(v: T | SolveError): v is SolveError {
  return typeof v === "object" && v !== null && "error" in (v as Record<string, unknown>);
}

/**
 * Solve the pair of mirror centres and normals.
 *
 * `currentA` / `currentB` are the mirrors' present lab centres and are used
 * ONLY to pick the default value of the free DOF in the collinear branch
 * (least total travel). They never influence the unique branch.
 */
export function solveCouplingGeometry(args: {
  inRay: Ray;
  targetRay: Ray;
  currentA: Vec3;
  currentB: Vec3;
  /** Override the free DOF (mm along d0 from the input ray's origin).
   *  Ignored when the solution is unique. */
  foldMm?: number;
  /** Clear-aperture radii, used only for the "mirrors may foul" warning. */
  apertureAMm?: number;
  apertureBMm?: number;
}): CouplingGeometry | SolveError {
  const inRay = normaliseRay(args.inRay);
  const targetRay = normaliseRay(args.targetRay);
  if (!inRay) return { error: "Input beam direction is degenerate." };
  if (!targetRay) return { error: "Target port declares no usable axis direction." };

  const pIn = inRay.origin;
  const d0 = inRay.dir;
  const pT = targetRay.origin;
  const dT = targetRay.dir;

  const w = sub(pT, pIn);
  const sinTheta = len(cross(d0, dT));

  let centreA: Vec3;
  let centreB: Vec3;
  let freeDof: boolean;

  if (sinTheta > COLLINEAR_SIN_EPS) {
    // Unique branch. C_B - C_A must be perpendicular to BOTH d0 and dT
    // (that is exactly "45 deg at each mirror"), which is two linear
    // equations in the two line parameters:
    //     (C_B - C_A) . d0 = 0
    //     (C_B - C_A) . dT = 0
    const c = dot(d0, dT);
    const a = dot(w, d0);
    const b = dot(w, dT);
    const den = 1 - c * c; // = |d0 x dT|^2, non-zero here
    const s = (a - c * b) / den;
    const u = (c * a - b) / den;
    centreA = add(pIn, mul(d0, s));
    centreB = add(pT, mul(dT, u));
    freeDof = false;
  } else {
    // Collinear branch: L_in and L_tgt are parallel (a U-turn when
    // dT = -d0, a periscope when dT = +d0). d1 is still pinned to the
    // perpendicular offset between the lines, but the pair may slide along
    // d0 together.
    const wPerp = sub(w, mul(d0, dot(w, d0)));
    if (len(wPerp) < MIN_PERP_OFFSET_MM) {
      return {
        error:
          "The input beam and the target axis are the same line — two mirrors "
          + "would have nothing to correct. Offset the target, or steer with one mirror.",
      };
    }
    // Least-travel default: minimise |C_A - curA|^2 + |C_B - curB|^2 over
    // the slide parameter f, with C_B = C_A + wPerp.
    const fDefault =
      (dot(sub(args.currentA, pIn), d0) + dot(sub(sub(args.currentB, pIn), wPerp), d0)) / 2;
    const f = typeof args.foldMm === "number" && Number.isFinite(args.foldMm)
      ? args.foldMm
      : fDefault;
    centreA = add(pIn, mul(d0, f));
    centreB = add(centreA, wPerp);
    freeDof = true;
  }

  const legVec = sub(centreB, centreA);
  const legLengthMm = len(legVec);
  if (legLengthMm < MIN_PERP_OFFSET_MM) {
    return {
      error:
        "The two mirror centres come out on top of each other — the input beam "
        + "already meets the target axis. No two-mirror pair is needed here.",
    };
  }
  const d1 = unitOrThrow(legVec);

  // Reflection law, with nothing left to choose: each normal is the
  // bisector of (incoming reversed, outgoing).
  const normalA = unitOrThrow(sub(d1, d0));
  const normalB = unitOrThrow(sub(dT, d1));

  const foldMm = dot(sub(centreA, pIn), d0);
  const targetStandoffMm = dot(sub(centreB, pT), dT);

  const warnings: string[] = [];
  if (foldMm <= 0) {
    warnings.push(
      `Mirror A lands ${Math.abs(foldMm).toFixed(1)} mm UPSTREAM of where the input `
      + "beam starts — the beam would never reach it.",
    );
  }
  if (targetStandoffMm >= 0) {
    warnings.push(
      `Mirror B lands ${targetStandoffMm.toFixed(1)} mm PAST the destination port — `
      + "the beam would have to travel backwards.",
    );
  }
  const clearance = (args.apertureAMm ?? 0) + (args.apertureBMm ?? 0);
  if (clearance > 0 && legLengthMm < clearance) {
    warnings.push(
      `The two mirrors end up ${legLengthMm.toFixed(1)} mm apart, less than their `
      + `combined clear radii (${clearance.toFixed(1)} mm) — the bodies will foul.`,
    );
  }

  return {
    d1,
    centreA,
    centreB,
    normalA,
    normalB,
    legLengthMm,
    freeDof,
    foldMm,
    targetStandoffMm,
    warnings,
  };
}

// ─── pose synthesis ────────────────────────────────────────────────────────

export type MirrorMove = {
  objectId: string;
  name: string;
  pose: AlignPose;
  /** How far the mirror centre moves (mm). */
  travelMm: number;
  /** Magnitude of the applied rotation (deg). */
  rotationDeg: number;
};

/**
 * Pose that puts `mirror`'s face centre at `centreLab` with its outward
 * normal along `normalLab`.
 *
 * Minimal disturbance, deliberately: the rotation is the SHORTEST rotation
 * carrying the current normal onto the target one, pre-multiplied onto the
 * mirror's existing quaternion. A round mirror is symmetric about its normal,
 * so its roll is physically meaningless — but the mount, the post and the
 * user's mental picture are not, and a from-scratch `setFromUnitVectors` on a
 * canonical axis would spin them for nothing.
 */
export function poseMirrorTo(
  mirror: MirrorFacts,
  centreLab: Vec3,
  normalLab: Vec3,
): MirrorMove {
  const qCur = sceneObjectToQuaternion(mirror.sceneObject);
  const from = labDirToThreeLocal(mirror.normalLab).normalize();
  const to = labDirToThreeLocal(normalLab).normalize();
  const qDelta = new THREE.Quaternion().setFromUnitVectors(from, to);
  const qNew = qDelta.clone().multiply(qCur);

  const rotatedCentre = labDirToThreeLocal(mirror.centreCad).applyQuaternion(qNew);
  const { rxDeg, ryDeg, rzDeg } = sceneObjectEulerFromQuaternion(qNew);

  return {
    objectId: mirror.objectId,
    name: mirror.name,
    pose: {
      xMm: centreLab.x - rotatedCentre.x,
      yMm: centreLab.y - rotatedCentre.y,
      zMm: centreLab.z - rotatedCentre.z,
      rxDeg,
      ryDeg,
      rzDeg,
    },
    travelMm: len(sub(centreLab, mirror.centreLab)),
    rotationDeg: (2 * Math.acos(Math.min(1, Math.abs(qDelta.w))) * 180) / Math.PI,
  };
}

// ─── the whole plan ────────────────────────────────────────────────────────

export type CouplingPlan = {
  geometry: CouplingGeometry;
  moveA: MirrorMove;
  moveB: MirrorMove;
  /** Spot decentre on each mirror BEFORE the move (mm), from the live
   *  touch check — after the move both are zero by construction. */
  beforeDecentreAMm: number | null;
  beforeDecentreBMm: number | null;
  /** How far the current outgoing beam misses the destination axis (mm),
   *  before the move. null when the seed never reaches B. */
  beforeTargetMissMm: number | null;
};

/** Solve + synthesise both poses in one call. */
export function planMirrorCoupling(args: {
  inRay: Ray;
  targetRay: Ray;
  a: MirrorFacts;
  b: MirrorFacts;
  foldMm?: number;
  touch?: TouchMatrix;
}): CouplingPlan | SolveError {
  const { a, b } = args;
  const geometry = solveCouplingGeometry({
    inRay: args.inRay,
    targetRay: args.targetRay,
    currentA: a.centreLab,
    currentB: b.centreLab,
    foldMm: args.foldMm,
    apertureAMm: a.apertureMm,
    apertureBMm: b.apertureMm,
  });
  if (isSolveError(geometry)) return geometry;

  const touch = args.touch
    ?? checkMirrorTouch({ inRay: args.inRay, targetRay: args.targetRay, a, b });

  return {
    geometry,
    moveA: poseMirrorTo(a, geometry.centreA, geometry.normalA),
    moveB: poseMirrorTo(b, geometry.centreB, geometry.normalB),
    beforeDecentreAMm: touch.seedOnA?.decentreMm ?? null,
    beforeDecentreBMm: touch.seedOnB?.decentreMm ?? null,
    beforeTargetMissMm: currentTargetMissMm(args.inRay, args.targetRay, a, b),
  };
}

/** Perpendicular distance from the destination axis to the beam that
 *  currently leaves mirror B — the single number that says whether the
 *  coupling is right. null when the seed never gets that far. */
export function currentTargetMissMm(
  inRay: Ray,
  targetRay: Ray,
  a: MirrorFacts,
  b: MirrorFacts,
): number | null {
  const hitA = intersectMirror(inRay, a);
  if (!hitA || hitA.tMm <= 0) return null;
  const afterA: Ray = { origin: hitA.pointLab, dir: reflect(inRay.dir, a.normalLab) };
  const hitB = intersectMirror(afterA, b);
  if (!hitB || hitB.tMm <= 0) return null;
  const outDir = reflect(afterA.dir, b.normalLab);

  // Distance between two lines: |(p2 - p1) . unit(d1 x d2)|, falling back to
  // the point-line distance when they are parallel.
  const p1 = hitB.pointLab;
  const p2 = targetRay.origin;
  const n = cross(outDir, targetRay.dir);
  const nLen = len(n);
  const diff = sub(p2, p1);
  if (nLen < COLLINEAR_SIN_EPS) {
    const along = mul(outDir, dot(diff, outDir));
    return len(sub(diff, along));
  }
  return Math.abs(dot(diff, mul(n, 1 / nLen)));
}
