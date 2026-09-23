/**
 * The align solvers, called over HTTP — `POST /api/v3/align/*`.
 *
 * These solvers used to exist twice: once here in TypeScript
 * (`utils/mirrorCoupling.ts`, `utils/isolatorAlign.ts`, `utils/aomAlign.ts`)
 * and once in `backend/app/optical/align/`, pinned to each other by golden
 * fixtures. The TypeScript copies are gone; this module is the web app's only
 * route to them, so there is exactly one implementation and the qmem-blender
 * add-on and the web app cannot drift.
 *
 * Everything here is COMPUTE-ONLY (`routers/v3_align.py`): each call reads the
 * DB scene, solves, and returns PROPOSED poses. Applying one is an ordinary
 * `updateSceneObject(s)` by the caller, which is what keeps the store's undo /
 * redo behaviour exactly as it was when the maths ran in-process.
 *
 * What stays on this side: which beam, which seed segment, the mirror A/B
 * order, the target list, the panels and their state. What crosses: every
 * pose, plan and readout.
 *
 * Shapes: `docs/introduce/api.md` (§ The align endpoints); the solvers'
 * behaviour: `docs/introduce/mirror-coupling.md`.
 *
 * ⚠️ The backend reads each object's pose from the DATABASE, not from the
 * store. The store writes through (`updateObjectApi` is awaited before the
 * local scene is patched), so the two agree at rest — but a pose that has not
 * been committed yet (a drag in flight, a `previewObjectTransform` ghost) is
 * invisible to these endpoints, by design: the ghost is not where the object
 * is.
 */
import { apiErrorMessage, client } from "./client";

export type AlignVec3 = { x: number; y: number; z: number };

/** A proposed SceneObject pose, lab mm / deg, already on the 1e-9° grid. */
export type AlignPose = {
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
};

/** A beam line in lab mm: any point on it plus the propagation direction. */
export type AlignRay = { origin: AlignVec3; dir: AlignVec3 };

// ── mirror coupling ────────────────────────────────────────────────────────

/** One ray meeting one mirror's plane. `tMm` is signed (negative = behind the
 *  ray's origin) and `decentreMm` is the spot offset the solve drives to 0. */
export type MirrorSpotHit = {
  pointLab: AlignVec3;
  decentreMm: number;
  tMm: number;
  inAperture: boolean;
  frontSide: boolean;
  aoiDeg: number;
};

/** The 2×2 precondition at the mirrors' CURRENT poses: both beams must touch
 *  both mirrors before a solve means anything (mirror-coupling.md, R6). */
export type MirrorTouchMatrix = {
  seedOnA: MirrorSpotHit | null;
  seedOnB: MirrorSpotHit | null;
  targetOnB: MirrorSpotHit | null;
  targetOnA: MirrorSpotHit | null;
  ok: boolean;
  failures: string[];
};

/** A mirror's reflective face, as the backend resolved it through the binding
 *  tree. `apertureMm` is a RADIUS. */
export type MirrorFactsOut = {
  objectId: string;
  name: string;
  locked: boolean;
  centreCad: AlignVec3;
  normalCad: AlignVec3;
  centreLab: AlignVec3;
  normalLab: AlignVec3;
  apertureMm: number;
};

export type CouplingGeometry = {
  d1: AlignVec3;
  centreA: AlignVec3;
  centreB: AlignVec3;
  normalA: AlignVec3;
  normalB: AlignVec3;
  legLengthMm: number;
  /** The collinear (U-turn / periscope) branch, where `foldMm` is a real
   *  degree of freedom the caller may sweep. */
  freeDof: boolean;
  foldMm: number;
  targetStandoffMm: number;
  warnings: string[];
};

export type MirrorMove = {
  objectId: string;
  name: string;
  pose: AlignPose;
  travelMm: number;
  rotationDeg: number;
};

export type CouplingPlan = {
  geometry: CouplingGeometry;
  moveA: MirrorMove;
  moveB: MirrorMove;
  beforeDecentreAMm: number | null;
  beforeDecentreBMm: number | null;
  beforeTargetMissMm: number | null;
};

export type MirrorCouplingResult = {
  mirrorA: MirrorFactsOut;
  mirrorB: MirrorFactsOut;
  inRay: AlignRay;
  targetRay: AlignRay;
  touch: MirrorTouchMatrix;
  /** null (with `error` set) when no 45/45 pair exists for this geometry.
   *  `touch` is reported either way. */
  plan: CouplingPlan | null;
  error: string | null;
  passThroughMoves: { objectId: string; name: string; pose: AlignPose }[];
  passThroughSkipped: { objectId: string; reason: string }[];
};

export type MirrorCouplingRequest = {
  /** The mirror the seed reaches FIRST (A/B order is the trace's). */
  mirrorAId: string;
  mirrorBId: string;
  /** The traced segment that ends on mirror A (`origin` = its start). */
  inRay: AlignRay;
  target: { objectId: string; anchorId: string; anchorName?: string | null };
  /** The collinear branch's free DOF, mm along the seed from `inRay.origin`.
   *  null / omitted = least total travel. Ignored when the answer is unique. */
  foldMm?: number | null;
  /** Optics between B and the port to re-centre on the new axis (translate
   *  only). Locked ones come back in `passThroughSkipped`. */
  passThroughObjectIds?: string[];
};

/** Solve two 45° steering mirrors into a destination port
 *  (`docs/introduce/mirror-coupling.md`). Nothing is written. */
export async function alignMirrorCouplingApi(
  request: MirrorCouplingRequest,
): Promise<MirrorCouplingResult> {
  try {
    const response = await client.post<MirrorCouplingResult>(
      "/api/v3/align/mirror-coupling",
      request,
    );
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

// ── point + direction align (the isolator and every pass-through optic) ────

export type AlignBeam = {
  dir: AlignVec3;
  ref: AlignVec3;
  /** Only the AOM endpoint reads it (the Bragg angle). */
  wavelengthNm?: number | null;
};

export type PointDirAlignResult = {
  objectId: string;
  name: string;
  locked: boolean;
  /** Which of the three resolution steps supplied (point, direction). */
  alignSource: "alignSpec" | "polariserCentres" | "primaryAnchor";
  /** The align point / direction in the Component CAD frame — what the beam
   *  picker measures its candidates against. */
  pointCadMm: AlignVec3;
  dirCadMm: AlignVec3;
  reverse: boolean;
  rollDeg: number;
  /** null (with `error`) when the direction is degenerate. */
  pose: AlignPose | null;
  error: string | null;
};

export type PointDirAlignRequest = {
  objectId: string;
  beam: AlignBeam;
  /** null / omitted = the object's stored `properties.alignReverse` /
   *  `alignRollDeg`, which is what the Object panel persists. */
  reverse?: boolean | null;
  rollDeg?: number | null;
};

/** "Align to beam": a point of the body onto the beam line, a body direction
 *  along it. Used for the isolator and every other pass-through optic.
 *
 *  The (point, direction) resolution — alignSpec, else the binding tree's
 *  front/back polariser centres, else the primary asset's entry anchor — lives
 *  behind this call, so `pointCadMm` / `dirCadMm` in the response are the
 *  panel's only source for where the align point is. */
export async function alignPointDirApi(
  request: PointDirAlignRequest,
): Promise<PointDirAlignResult> {
  try {
    const response = await client.post<PointDirAlignResult>("/api/v3/align/isolator", request);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}

// ── AOM Bragg align ────────────────────────────────────────────────────────

export type AomBraggFrame = {
  D1: AlignVec3;
  D2: AlignVec3;
  D3: AlignVec3;
  centreMm: AlignVec3;
};

export type AomOrderReadout = {
  order: number;
  /** How far this order is from ITS Bragg-matched incidence (rad). */
  mismatchRad: number;
  /** sinc² phase-matching factor ∈ [0, 1]. */
  phaseMatch: number;
};

export type AomBraggReadout = {
  thetaInRad: number;
  matchedOrder: number;
  orders: AomOrderReadout[];
};

export type AomBraggResult = {
  objectId: string;
  name: string;
  locked: boolean;
  frame: AomBraggFrame;
  order: number;
  fineTuneMrad: number;
  reverse: boolean;
  rollDeg: number;
  wavelengthNm: number;
  freqMhz: number;
  /** Which source the drive frequency came from; `rfLink` = the live RF
   *  chain, the rest are stored fallbacks. */
  freqSource: "request" | "rfLink" | "dynamicSources" | "asset" | "default";
  acousticVelocityMps: number;
  refractiveIndex: number;
  crystalLengthMm: number;
  thetaBRad: number;
  /** The full stage-2 angle: `order · θ_B` + the fine tune. */
  tiltRad: number;
  /** Measured at the CURRENT pose. null when the beam direction is degenerate. */
  readout: AomBraggReadout | null;
  /** null (with `error`) for order 0 or degenerate geometry. */
  pose: AlignPose | null;
  /** The same readout at the PROPOSED pose. */
  readoutAfter: AomBraggReadout | null;
  /** Only present when `nudgeMrad` was sent: the rotation-stage nudge of the
   *  CURRENT pose about D3, pivoting on the interaction centre. */
  nudgePose: AlignPose | null;
  error: string | null;
};

export type AomBraggRequest = {
  objectId: string;
  beam: AlignBeam;
  /** null / omitted = the stored value; see `docs/introduce/api.md`. */
  order?: number | null;
  fineTuneMrad?: number | null;
  reverse?: boolean | null;
  rollDeg?: number | null;
  freqMhz?: number | null;
  /** Which RF snapshot to read the drive frequency from; null = rest. */
  scrubTimeNs?: number | null;
  /** Also return the rotation-stage nudge of the CURRENT pose by this much. */
  nudgeMrad?: number | null;
};

/** The AOM's two-stage Bragg align plus the live incidence readout
 *  (`docs/aom-model.md`). One call answers both "where should it sit" and
 *  "where does it sit now", so the panel never measures one and solves the
 *  other. */
export async function alignAomBraggApi(request: AomBraggRequest): Promise<AomBraggResult> {
  try {
    const response = await client.post<AomBraggResult>("/api/v3/align/aom-bragg", request);
    return response.data;
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}
