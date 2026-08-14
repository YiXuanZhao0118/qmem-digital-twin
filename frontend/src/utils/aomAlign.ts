/**
 * AOM Bragg positioning — the geometry behind "put this AOM at the right
 * angle to the input beam for the +1 / −1 order".
 *
 * Body frame (matches `optical/kinds/aom/physics.ts`, MT80-A1.5-IR values in
 * brackets):
 *   D1 = optical axis   = intercept_out − intercept_in        [body +Y]
 *   D2 = acoustic axis  = acoustic_axis anchor, else the
 *                         rfPropagationDirectionBodyLocal param [body −X]
 *   D3 = D1 × D2        = the Bragg rotation axis              [body +Z]
 * D2 is re-orthogonalised against D1 (authored axes are only nominally
 * perpendicular), so {D1, D2, D3} is a right-handed orthonormal triad.
 *
 * Two-stage align (the design in `docs/aom_align_*.py`, confirmed with the
 * user 2026-08-14):
 *   Stage 1 — put the interaction centre on the beam and D1 parallel to it
 *             (forward) or anti-parallel (`reverse`), i.e. the ordinary
 *             point+direction align every optical kind uses.
 *   Stage 2 — rotate the body by `+m·θ_B` about D3 around the interaction
 *             centre, so the beam arrives at the Bragg-matched incidence
 *             `k̂·D̂2 = −m·sin θ_B` for the selected order m.
 *
 * Sign convention CONV-2 ("lab-fixed"): the stage-2 rotation is `+m·θ_B`
 * regardless of traversal, so the user's "+1" always tilts the cell the same
 * way and the diffracted beam always leaves on the same lab side. When the
 * beam traverses the cell backwards (`reverse`), that same tilt Bragg-matches
 * order −m — physically correct for a cell used in reverse, and reported by
 * `aomBraggReadout().matchedOrder` so the UI can say so out loud.
 *
 * The efficiency model that consumes this geometry lives in
 * `optical/kinds/aom/physics.ts` (`braggOrderDetune`), mirrored by the
 * backend's `aom_physics.py` — see `docs/aom-model.md`.
 */
import * as THREE from "three";

import type { Asset3D, SceneObject } from "../types/digitalTwin";
import {
  labDirToThreeLocal,
  rotateLabDir,
  sceneObjectEulerFromQuaternion,
  sceneObjectToQuaternion,
} from "../optical/frames";
import {
  acousticIncidenceRad,
  braggMatchedIncidenceRad,
  braggOrderDetune,
} from "../optical/kinds/aom/physics";
import { anchorObjectLocalPos, anchorObjectLocalPrimaryDir } from "./anchorAccess";
import { cadToLab, computePointDirAlignPose, type AlignPose, type Vec3 } from "./isolatorAlign";

/** Body/CAD-frame Bragg triad + the interaction centre (the rotation pivot
 *  and the point that lands on the beam). */
export type AomBraggFrame = {
  D1: Vec3;
  D2: Vec3;
  D3: Vec3;
  centreMm: Vec3;
};

const unit = (v: Vec3): Vec3 | null => {
  const m = Math.hypot(v.x, v.y, v.z);
  return m < 1e-9 ? null : { x: v.x / m, y: v.y / m, z: v.z / m };
};
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

function readVec3(raw: unknown): Vec3 | null {
  if (Array.isArray(raw) && raw.length >= 3 && raw.slice(0, 3).every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { x: raw[0] as number, y: raw[1] as number, z: raw[2] as number };
  }
  if (raw && typeof raw === "object") {
    const o = raw as { x?: unknown; y?: unknown; z?: unknown };
    if ([o.x, o.y, o.z].every((n) => typeof n === "number" && Number.isFinite(n))) {
      return { x: o.x as number, y: o.y as number, z: o.z as number };
    }
  }
  return null;
}

/** Build the Bragg triad from an AOM Asset3D: the two intercept anchors give
 *  D1 + the centre; the acoustic direction comes from the `acoustic_axis`
 *  anchor when present (the first-class form, migration 0099), else the
 *  `rfPropagationDirectionBodyLocal` / `acousticAxisBodyLocal` default param
 *  (what the live MT80 row still carries).
 *
 *  Returns null when the asset is missing an intercept pair or the acoustic
 *  direction is absent / parallel to the optical axis. */
export function resolveAomBraggFrame(asset: Asset3D | null | undefined): AomBraggFrame | null {
  const anchors = asset?.anchors ?? [];
  const inAnchor = anchors.find((a) => a.id === "intercept_in");
  const outAnchor = anchors.find((a) => a.id === "intercept_out");
  if (!inAnchor || !outAnchor) return null;
  const pIn = anchorObjectLocalPos(inAnchor, asset);
  const pOut = anchorObjectLocalPos(outAnchor, asset);
  const D1 = unit({ x: pOut.x - pIn.x, y: pOut.y - pIn.y, z: pOut.z - pIn.z });
  if (!D1) return null;

  const acousticAnchor = anchors.find((a) => a.id === "acoustic_axis");
  const params = (asset?.defaultParams ?? {}) as Record<string, unknown>;
  const rawAcoustic =
    (acousticAnchor ? anchorObjectLocalPrimaryDir(acousticAnchor, asset) : null)
    ?? readVec3(params.rfPropagationDirectionBodyLocal)
    ?? readVec3(params.acousticAxisBodyLocal);
  const acoustic = rawAcoustic ? unit(rawAcoustic) : null;
  if (!acoustic) return null;

  // Re-orthogonalise: keep only the part of the acoustic axis perpendicular
  // to D1 (an authored axis a degree off perpendicular must not skew D3).
  const par = dot(acoustic, D1);
  const D2 = unit({
    x: acoustic.x - D1.x * par,
    y: acoustic.y - D1.y * par,
    z: acoustic.z - D1.z * par,
  });
  if (!D2) return null;
  const D3 = unit(cross(D1, D2));
  if (!D3) return null;

  return {
    D1,
    D2,
    D3,
    centreMm: {
      x: (pIn.x + pOut.x) / 2,
      y: (pIn.y + pOut.y) / 2,
      z: (pIn.z + pOut.z) / 2,
    },
  };
}

/** Stage 1 + stage 2 pose: interaction centre on the beam, D1 along ±beam,
 *  then tilted by `tiltRad` about D3 about that centre.
 *
 *  `tiltRad` is the FULL stage-2 angle — `braggTiltRad(order, θ_B) + fine
 *  tune`. Returns null when the frame is degenerate. */
export function computeAomBraggAlignPose(args: {
  frame: AomBraggFrame;
  sceneObject: SceneObject;
  beamDir: Vec3;
  beamRef: Vec3;
  reverse?: boolean;
  rollDeg?: number;
  tiltRad: number;
}): AlignPose | null {
  const { frame, sceneObject, beamDir, beamRef, reverse, rollDeg, tiltRad } = args;
  return computePointDirAlignPose({
    pointCadMm: frame.centreMm,
    dirCadMm: frame.D1,
    sceneObject,
    beamDir,
    beamRef,
    reverse,
    rollDeg,
    extraTilt: { axisCadMm: frame.D3, angleRad: tiltRad },
  });
}

/** Stage-2 rotation for the selected order under CONV-2 (lab-fixed): the
 *  body turns `+m·θ_B` about D3. */
export function braggTiltRad(order: number, thetaBRad: number): number {
  return order * thetaBRad;
}

/** Nudge the CURRENT pose by `deltaRad` about the lab-frame D3, pivoting on
 *  the interaction centre — the software equivalent of walking the AOM's
 *  rotation stage while watching the diffracted power. The pivot stays put,
 *  so an already-aligned cell stays on the beam. */
export function computeAomTiltNudgePose(args: {
  frame: AomBraggFrame;
  sceneObject: SceneObject;
  deltaRad: number;
}): AlignPose {
  const { frame, sceneObject, deltaRad } = args;
  const axisLab = rotateLabDir(frame.D3, sceneObject);
  const axis = labDirToThreeLocal(axisLab).normalize();
  const delta = new THREE.Quaternion().setFromAxisAngle(axis, deltaRad);
  const quat = delta.clone().multiply(sceneObjectToQuaternion(sceneObject));

  // Keep the interaction centre fixed: pos' = pivot − Δ·(pivot − pos).
  const pivot = cadToLab(frame.centreMm, sceneObject);
  const arm = new THREE.Vector3(
    pivot.x - sceneObject.xMm,
    pivot.y - sceneObject.yMm,
    pivot.z - sceneObject.zMm,
  ).applyQuaternion(delta);
  const { rxDeg, ryDeg, rzDeg } = sceneObjectEulerFromQuaternion(quat);
  return {
    xMm: pivot.x - arm.x,
    yMm: pivot.y - arm.y,
    zMm: pivot.z - arm.z,
    rxDeg,
    ryDeg,
    rzDeg,
  };
}

export type AomOrderReadout = {
  order: number;
  /** How far this order is from ITS Bragg-matched incidence (rad). */
  mismatchRad: number;
  /** sinc² phase-matching factor ∈ [0, 1] at the current pose. */
  phaseMatch: number;
};

export type AomBraggReadout = {
  /** Signed incidence of the beam about D2 at the CURRENT pose (rad). */
  thetaInRad: number;
  /** The order this pose is closest to Bragg-matching. */
  matchedOrder: number;
  orders: AomOrderReadout[];
};

/** Measure the current pose against the Bragg condition — everything the
 *  panel needs to show "how far off am I, and for which order".
 *
 *  Measured from geometry (the object's live pose + the chosen beam's
 *  propagation direction), NOT from the last align, so a hand-dragged object
 *  reads correctly too. */
export function aomBraggReadout(args: {
  frame: AomBraggFrame;
  sceneObject: SceneObject;
  /** Beam PROPAGATION direction in lab mm (start → end of the trace segment). */
  beamDir: Vec3;
  thetaBRad: number;
  wavelengthNm: number;
  freqMhz: number;
  acousticVelocityMps: number;
  refractiveIndex: number;
  crystalLengthMm: number;
  orders?: number[];
}): AomBraggReadout | null {
  const {
    frame, sceneObject, beamDir, thetaBRad, wavelengthNm, freqMhz,
    acousticVelocityMps, refractiveIndex, crystalLengthMm,
  } = args;
  const beam = unit(beamDir);
  if (!beam) return null;
  // Dot products are rotation-invariant, so measuring in lab (body axes
  // rotated by the object pose) equals measuring in body frame.
  const thetaInRad = acousticIncidenceRad(
    beam,
    rotateLabDir(frame.D2, sceneObject),
    rotateLabDir(frame.D1, sceneObject),
  );
  if (thetaInRad === null) return null;

  const orders = (args.orders ?? [1, -1]).map((order) => ({
    order,
    mismatchRad: thetaInRad - braggMatchedIncidenceRad(order, thetaBRad),
    phaseMatch: braggOrderDetune(
      order, thetaInRad, thetaBRad, wavelengthNm, freqMhz,
      acousticVelocityMps, refractiveIndex, crystalLengthMm,
    ),
  }));
  const matchedOrder = thetaBRad > 0
    ? Math.round(-thetaInRad / thetaBRad)
    : 0;
  return { thetaInRad, matchedOrder, orders };
}
