// Geometry-driven forward ray tracer.
//
// Unlike the topology solver in `backend/app/solvers/optical_solver.py`, this
// runs in the browser and uses the actual loaded 3D meshes for hit detection.
//
// Behaviour:
//   1. For every laser_source / tapered_amplifier SceneObject, emit a ray
//      starting at the SceneObject origin, pointing along the SceneObject's
//      local +X axis (rotated by rxDeg/ryDeg/rzDeg).
//   2. Cast against `componentGroup`'s meshes. The ray extends DEFAULT_MAX_LENGTH_MM
//      (1 m by default) or until it hits a component.
//   3. On hit, dispatch by the hit element's element_kind:
//        - mirror / dichroic_mirror → reflect using the hit face's world normal
//        - beam_splitter           → split into transmitted + reflected (each
//                                    continues 1 m). Polarising flag stored
//                                    in TraceSegment.polarization branch tag
//                                    so the renderer can colour them
//        - waveplate, polarizer, lens, isolator, aom, eom, fiber_coupler →
//                                    pass-through (same direction, no refraction)
//        - detector, camera, beam_dump, spectrometer, wavemeter,
//          nonlinear_crystal, saturable_absorber, unknown → absorb (stop)
//   4. Recursion is bounded by DEFAULT_MAX_BOUNCES.

import * as THREE from "three";

import type {
  Asset3D,
  ComponentItem,
  ElementKind,
  PhysicsElement,
  SceneObject,
} from "../types/digitalTwin";
import { mmToThree, labToThreeVector } from "./transformUtils";
import {
  bodyLocalDirToLabDir,
  bodyLocalDirToWorldThree,
  labDirToThree as labDirToThreeAxisSwap,
} from "../optical/frames";
import { rotateLocalToLab } from "../utils/beamPlacement";
import { FIBER_FERRULE_TIP_MM } from "../utils/fiberAnchorResolver";
import { endpointOutwardBody } from "../utils/fiberAlignment";
import { emissionFromObject } from "./opticalBeams";
import {
  type AomTraversalSign,
  besselJ,
  braggAngleRad,
  diffractedDirection,
  diffractionEfficiency,
  expectedInputDotD2,
  phaseModulationDepth,
} from "../optical/kinds/aom/physics";
import { getRfDirectionBodyLocal } from "../utils/v2Bindings";
import { resolveAomRfDriveFromScene } from "../utils/aomRfDrive";
import { getEmissionVisual } from "../utils/emissionVisuals";

export const DEFAULT_MAX_LENGTH_MM = 1000;
export const DEFAULT_MAX_BOUNCES = 8;
const OPTICAL_C_M_PER_S = 299_792_458;
const RAY_EPS_THREE = 5e-4; // ~0.05 mm — push past the hit face

export type TraceBranch = "main" | "transmitted" | "reflected";

export type TraceSegment = {
  /** Start point in Three units (already in three coordinate frame). */
  startThree: THREE.Vector3;
  /** End point in Three units. */
  endThree: THREE.Vector3;
  /** componentId the segment terminates on, or null if it ran to max length. */
  componentIdHit: string | null;
  /** SceneObject id the segment terminates on, or null if it ran to max length.
   *  Carried so snap-to-beam can distinguish multiple instances of the same
   *  component (e.g. Mirror1 vs Mirror2 sharing one componentId). */
  hitObjectId: string | null;
  /** SceneObject id that emitted/reflected this segment — the laser for
   *  depth=0 main, the previously-hit object for reflected/transmitted. */
  sourceObjectId: string;
  branch: TraceBranch;
  depth: number;
  /** Approximate length in mm (lab frame). */
  lengthMm: number;
  /** wavelength in nm — for colouring; inherited from the source laser. */
  wavelengthNm: number;
  /** Gaussian beam radius w(z) in µm at the segment's start point. Computed
   * from the source laser's spatial mode with the standard formula
   * w(z) = w₀ · √(1 + (z·M²·λ/(π·w₀²))²). The path length z accumulates over
   * cumulative segment lengths so divergence keeps growing through reflections
   * and pass-throughs. */
  waistAtStartUm: number;
  /** Gaussian beam radius at the segment's end point (µm). */
  waistAtEndUm: number;
  /** componentId of the source emitter (laser/TA) — used by the beam-scope
   * panel to look up spectrum/power/etc. */
  sourceComponentId: string;
  /** Cumulative path length from the emitter to the START of this segment. */
  pathLengthFromSourceMmAtStart: number;
  /** Cumulative power factor relative to the emitter's nominal power at the
   *  START of this segment. 1.0 at emission; multiplied by each pass-through
   *  optic's transmission and split at beam splitters (transmitted gets the
   *  T-fraction, reflected gets the R-fraction). The beam-scope panel uses
   *  `nominalPowerMw * powerFactorAtStart` to display the actual power on the
   *  segment the user clicked on. */
  powerFactorAtStart: number;
  /** Absolute reference power in mW for this segment's source emission,
   *  before any in-chain attenuation. For a laser this equals
   *  kindParams.nominalPowerMw. For a tapered amplifier this differs per
   *  emission direction: forward emission uses the (input, current)
   *  interpolated forward power; backward emission uses the backward power
   *  from the same lookup (or pure-ASE backward power when no seed is
   *  present). Carrying this on every segment lets buildTraceLine compute
   *  brightness from absolute mW rather than chain-relative factor — needed
   *  because a TA's forward and backward beams share the same
   *  sourceComponentId but have very different absolute powers. */
  nominalPowerMwAtSource: number;
  /** Jones polarisation state at the START of this segment (in the beam's
   *  local x/y frame). Tracks waveplate rotation, polarizer projection, and
   *  PBS split through the chain. The four numbers are [Re(Ex), Im(Ex),
   *  Re(Ey), Im(Ey)]. Beam-scope reads this to display polarisation angle /
   *  ellipticity on the clicked segment so HWP / QWP / PBS effects are
   *  visible without running the backend solver. */
  polarizationAtStart: [number, number, number, number];
  /** Snapshot of the running Gaussian-beam state at the START of this segment.
   *  Carried so the renderer can sample w(z) at intermediate points along the
   *  segment — without this, a single linear taper between waistAtStartUm and
   *  waistAtEndUm misses any FOCUS that falls inside the segment (e.g. a
   *  short-focal-length lens with the focal point landing between two
   *  downstream pass-through optics). The state is invariant for the duration
   *  of the segment (waveplates / polarizers / mirrors don't change it; only
   *  lens hits create a new state for the NEXT segment). */
  beamMode: BeamState;
  /** TA-only diagnostic: seed/coupling terms used to create this segment. */
  taSeedCoupling?: {
    rawSeedPowerMw: number;
    effectiveSeedPowerMw: number;
    modeOverlap: number;
    polarizationOverlap: number;
    distanceToInputMm: number;
    seedSourceObjectId: string;
    seedBranch: TraceBranch;
  };
  aomSideband?: {
    order: number; // diffraction order (… −2, −1, 0, +1, +2 …)
    frequencyOffsetMhz: number;
    angleMrad: number;
    braggMismatchMrad: number;
    braggAngularFactor: number;
    relativeIntensity: number;
    centerFrequencyThz: number;
    centerWavelengthNm: number;
    requestedOrder?: number;
    matchedOrder?: number;
    inputTraversalSign?: -1 | 1;
    entryPortId?: "intercept_in" | "intercept_out";
  };
  /** Per-fiber-hop coupling breakdown. Set on the FIRST segment emitted
   *  out of a fiber's intercept_out; downstream segments past further
   *  optics don't carry it. The scope panel renders these as percentages
   *  so the user can see why the post-fiber beam is dimmer than the
   *  pre-fiber beam (mode mismatch vs Fresnel vs length attenuation). */
  fiberCoupling?: {
    etaMode: number;          // Marcuse Gaussian overlap (entry face)
    etaFresnel: number;       // (1-R_entry)·(1-R_exit) — both faces
    etaAttenuation: number;   // 10^(−α·L/10) Beer-Lambert along arc length
    etaTotal: number;         // etaMode · etaFresnel · etaAttenuation
    arcLengthM: number;       // fiber length in metres
    mfdEntryUm: number;       // mode-field diameter at entry face (µm)
    mfdExitUm: number;        // mode-field diameter at exit face (µm)
  };
  /** Identifies which emission this segment originated from, so the
   *  renderer can apply the per-emission visualisation override stored
   *  on `SceneObject.properties.emissionVisuals[emissionKey]`. Inherited
   *  from the originating emitter call to traceOneRay; downstream
   *  reflected/transmitted/diffracted children carry the same key. */
  emissionKey: "main" | "forward" | "backward";
  /** SceneObject id of the ORIGINAL emitter (laser_source / TA) that
   *  spawned this segment chain. Unlike `sourceObjectId` (which is the
   *  *previously-hit* object on recursive segments), this stays constant
   *  from the emitter all the way down so the renderer can look up the
   *  emitter's `emissionVisuals[emissionKey]` even on segments far
   *  downstream of optics. */
  emitterObjectId: string;
};

/** Running Gaussian-beam state propagated through traceOneRay. Carries the
 *  current waist parameters AND the path-length position of that waist so
 *  lens transforms can update where the focus is.
 *
 *  Conventions:
 *    - All lengths in µm.
 *    - `waistZUm` is the cumulative path-length from the source emitter at
 *      which the waist sits. Before any lens it equals the laser's
 *      `waistZOffsetMm * 1000`. After a thin-lens hit at path-length
 *      `lensZUm` we re-derive waist0/waistZ from the new q-parameter
 *      (1/q' = 1/q - 1/f).
 *    - `mSquared` and `wavelengthNm` are invariant (Gaussian propagation
 *      preserves M² and λ; lens doesn't change them). */
export type BeamState = {
  waist0Um: number;   // w₀ — beam-waist radius (µm)
  waistZUm: number;   // path-length from emitter to waist (µm)
  mSquared: number;
  wavelengthNm: number;
};

/** Average of the emitter's X and Y forward spatial modes — for visual
 *  rendering we collapse to a single circular cross-section. Reads from
 *  laser_source's `spatialModeX/Y` AND tapered_amplifier's
 *  `outputSpatialModeX/Y` (the TA stores the OUTPUT mode under a different
 *  key). Falls back to 100 µm circular if neither is present. */
function averageSpatialMode(element: PhysicsElement): BeamState {
  const params = (element.kindParams ?? {}) as {
    centerWavelengthNm?: number;
    spatialModeX?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
    spatialModeY?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
    outputSpatialModeX?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
    outputSpatialModeY?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
  };
  const xMode = params.spatialModeX ?? params.outputSpatialModeX;
  const yMode = params.spatialModeY ?? params.outputSpatialModeY;
  const wxUm = xMode?.waistUm ?? 100;
  const wyUm = yMode?.waistUm ?? 100;
  const mxSq = xMode?.mSquared ?? 1;
  const mySq = yMode?.mSquared ?? 1;
  const wxZ = xMode?.waistZOffsetMm ?? 0;
  const wyZ = yMode?.waistZOffsetMm ?? 0;
  return {
    waist0Um: 0.5 * (wxUm + wyUm),
    waistZUm: 1000 * 0.5 * (wxZ + wyZ),
    mSquared: 0.5 * (mxSq + mySq),
    wavelengthNm: typeof params.centerWavelengthNm === "number" ? params.centerWavelengthNm : 780,
  };
}

function rayleighRangeUm(state: BeamState): number {
  const w0 = state.waist0Um;
  if (w0 <= 0) return 0;
  return (Math.PI * w0 * w0) / (state.mSquared * state.wavelengthNm * 1e-3);
}

/** w(z) for a Gaussian beam with M² scaling. z is path-length from the
 *  emitter (µm). Returns radius in µm. */
export function gaussianWaistAtZ(zUm: number, state: BeamState): number {
  const w0 = state.waist0Um;
  if (w0 <= 0) return w0;
  const dz = zUm - state.waistZUm;
  const zR = rayleighRangeUm(state);
  return w0 * Math.sqrt(1 + (dz / zR) ** 2);
}

/** Apply a thin lens of focal length `focalUm` at path-length `lensZUm`.
 *  Uses 1/q' = 1/q - 1/f on the complex beam parameter q = (z - z_w) + i·z_R
 *  and re-derives the new waist (w₀') and new waist position (z_w'). After
 *  this the BeamState describes the focused beam downstream of the lens. */
function applyThinLens(state: BeamState, lensZUm: number, focalUm: number): BeamState {
  if (state.waist0Um <= 0 || !Number.isFinite(focalUm) || Math.abs(focalUm) < 1e-6) return state;
  const dz = lensZUm - state.waistZUm;
  const zR = rayleighRangeUm(state);
  // q = a + ib where a = dz, b = zR.
  const a = dz, b = zR;
  const denom = a * a + b * b;
  if (denom < 1e-12) return state;
  // 1/q  = a/denom - i·b/denom  ;  1/q' = 1/q - 1/f
  const reInv = a / denom - 1 / focalUm;
  const imInv = -b / denom;
  const denomInv = reInv * reInv + imInv * imInv;
  if (denomInv < 1e-30) return state;
  // q' = 1/(reInv + i·imInv) = (reInv - i·imInv)/denomInv
  const reQ = reInv / denomInv;
  const imQ = -imInv / denomInv;
  // q' has the form (lensZ - waistZ_new) + i·z_R_new ⇒ extract:
  const waistZNew = lensZUm - reQ;
  const zRNew = Math.abs(imQ);
  if (zRNew < 1e-12) return state;
  // z_R = π · w₀² / (M² · λ) ⇒ w₀ = √(z_R · M² · λ / π)
  const w0New = Math.sqrt((zRNew * state.mSquared * state.wavelengthNm * 1e-3) / Math.PI);
  return { ...state, waist0Um: w0New, waistZUm: waistZNew };
}

const ABSORBING_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>([
  "detector",
  "camera",
  "beam_dump",
  "spectrometer",
  "wavemeter",
  "nonlinear_crystal",
  "saturable_absorber",
]);

const PASSTHROUGH_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>([
  "lens_biconvex",
  "lens_plano_convex",
  "lens_cylindrical",
  "waveplate",
  "polarizer",
  "isolator",
  "eom",
  "fiber_coupler",
  // "aom" was here; now handled by a dedicated Bragg-diffraction branch
  // below (generates 0th + 1st order pair, frequency-shifts the 1st, and
  // works bidirectionally — either face can be the input).
]);

const REFLECTING_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>([
  "mirror",
  "dichroic_mirror",
]);

const SPLITTING_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>([
  "beam_splitter",
]);

type TraceContext = {
  componentGroup: THREE.Group;
  physicsElements: PhysicsElement[];
  components: ComponentItem[];
  assets: Asset3D[];
  /** Scene objects — needed to map a componentId → its instance object_id
   *  so we can look up the per-object PhysicsElement (alembic 0014).
   *  Must include the rotation Euler angles so the SPLITTING branch can
   *  rotate the coatingNormalLocal into world frame. */
  objects: SceneObject[];
  // pre-computed flat list of meshes that the raycaster targets
  targetMeshes: THREE.Object3D[];
  /** Phase RF.8 — per-SceneObject AOM/EOM frequency override (MHz) at
   *  the current scrub time. Threaded through traceOneRay so the AOM
   *  branch can pick instantaneous freq over kindParams.centerFreqMhz. */
  aomFreqOverrideMhz?: Map<string, number>;
};

/** Compute the world-space bounding box that wraps every mesh belonging to a
 * given componentId. Returns null if no meshes are found. */
function worldBBoxForComponent(
  cgroup: THREE.Group,
  componentId: string,
): THREE.Box3 | null {
  let combined: THREE.Box3 | null = null;
  cgroup.traverse((node) => {
    if (
      (node as THREE.Mesh).isMesh &&
      String(node.userData?.componentId) === componentId &&
      (node as THREE.Mesh).geometry
    ) {
      node.updateMatrixWorld(true);
      const mesh = node as THREE.Mesh;
      mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      const box = mesh.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld);
      if (combined === null) combined = box;
      else combined.union(box);
    }
  });
  return combined;
}

/** World-space anchor point inside a loaded mesh, given the anchor's
 *  position in the GLB's NATIVE Blender frame (Z-up, mm). Used to override
 *  the bbox-front-face fallback when a component's properties expose
 *  `apertureForwardLocalMm` / `apertureBackwardLocalMm`.
 *
 *  Caller flow:
 *    user reads aperture XYZ from Blender (Z-up) →
 *    stores as [bx, by, bz] mm on component.properties.apertureForwardLocalMm →
 *    we convert Blender (X right, Y forward-into-screen, Z up) →
 *    glTF/three (X right, Y up, Z out-of-screen) →
 *    add to the GLB-root group's local origin offset (which loadAssetObject
 *    set to -bboxCenter to bbox-center the mesh) →
 *    transform through wrapper.matrixWorld → world-space anchor point. */
function meshAperturePoint(
  cgroup: THREE.Group,
  componentId: string,
  apertureBlenderMm: [number, number, number],
): THREE.Vector3 | null {
  // The renderer wraps each SceneObject as: outerWrapper (componentId-tagged,
  // positioned at SceneObject lab pos) → innerWrapper (loadAssetObject's
  // Group) → glbSceneRoot (position = -bboxCenter, scale set via
  // applyAssetScale). The bbox-centering offset lives on glbSceneRoot, so
  // we walk down to find the deepest non-mesh ancestor of all meshes.
  // Heuristic: find any mesh under componentId, walk up to its highest
  // ancestor whose parent's children only contain non-mesh groups (i.e.
  // it's the immediate parent of mesh children).
  // Find the GLB scene root via array push so TS doesn't narrow the
  // mutable variable to `never` after callback assignment.
  const offsetBearing: THREE.Object3D[] = [];
  const meshParents: THREE.Object3D[] = [];
  cgroup.traverse((n) => {
    if (n.userData?.componentId === componentId && (n as THREE.Mesh).isMesh) {
      // climb until we leave the component subtree
      let cur: THREE.Object3D | null = n.parent;
      let lastWithComponent: THREE.Object3D | null = null;
      while (cur && cur.userData?.componentId === componentId) {
        lastWithComponent = cur;
        cur = cur.parent;
      }
      if (lastWithComponent) {
        // Within this subtree, prefer the descendant that has a non-zero
        // position (= the bbox-centering offset from loadAssetObject's
        // auto-center step). Falls back to the immediate parent of
        // mesh children if no offset-bearing group is found.
        lastWithComponent.traverse((c) => {
          if (
            c !== lastWithComponent &&
            !(c as THREE.Mesh).isMesh &&
            c.position.lengthSq() > 1e-12
          ) {
            offsetBearing.push(c);
          }
        });
        lastWithComponent.traverse((c) => {
          if (
            !(c as THREE.Mesh).isMesh &&
            c.children.some((cc) => (cc as THREE.Mesh).isMesh)
          ) {
            meshParents.push(c);
          }
        });
      }
    }
  });
  const glbSceneRoot: THREE.Object3D | undefined = offsetBearing[0] ?? meshParents[0];
  if (!glbSceneRoot) return null;

  // Blender (X right, Y forward, Z up) → glTF/three (X right, Y up, Z out
  // of screen): swap Y↔Z, negate Z. The default Blender→glTF exporter
  // applies this axis swap during export, so the GLB stores already-
  // converted coords; the user's reading from Blender's viewport is
  // therefore in Blender's pre-export frame.
  const [bx, by, bz] = apertureBlenderMm;
  const apertureGlbMm = new THREE.Vector3(bx, bz, -by);
  // mm → three units (matches mmToThree). The glbSceneRoot has
  // applyAssetScale(0.01) on it, so child positions are interpreted in mm
  // pre-scale; pushing the aperture through matrixWorld will apply the
  // scale automatically. So we leave apertureGlbMm in MM units (not three
  // units) — the matrixWorld will scale it.
  glbSceneRoot.updateMatrixWorld(true);
  return apertureGlbMm.applyMatrix4(glbSceneRoot.matrixWorld);
}

/** World-space emission origin for a laser-like emitter, derived from the
 * actual loaded mesh: place it on the front face of the mesh's world bbox
 * along the forward direction. This way the user's SceneObject (xMm, yMm, zMm)
 * just moves the whole wireframe — emission always exits the front of the
 * physical body, regardless of how the STL was authored. */
function meshFrontFaceCenter(
  cgroup: THREE.Group,
  componentId: string,
  forwardThree: THREE.Vector3,
): THREE.Vector3 | null {
  const box = worldBBoxForComponent(cgroup, componentId);
  if (!box) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const f = forwardThree.clone().normalize();
  // Half-extent of the box projected onto the forward axis. For a box, the
  // farthest front-face displacement is sum_i |f_i| * halfSize_i. Equivalent
  // to the support function for an AABB along direction f.
  const forwardExtent =
    Math.abs(f.x) * size.x * 0.5 +
    Math.abs(f.y) * size.y * 0.5 +
    Math.abs(f.z) * size.z * 0.5;
  return center.add(f.clone().multiplyScalar(forwardExtent + RAY_EPS_THREE));
}

function labDirToThree(v: { x: number; y: number; z: number }): THREE.Vector3 {
  // Lab Z-up direction → three Y-up direction (axis swap). Wraps the
  // unification helper from `optical/frames` and adds a normalize() so
  // callers can keep treating the result as a unit vector.
  return labDirToThreeAxisSwap(v).normalize();
}

function elementKindFor(componentId: string, ctx: TraceContext): ElementKind | null {
  // Per-object OE: find any OE whose object_id belongs to a scene object of
  // this component. First match wins (rayTrace doesn't differentiate
  // instances of the same component template).
  const objIds = new Set(
    ctx.objects.filter((o) => o.componentId === componentId).map((o) => o.id),
  );
  const el = ctx.physicsElements.find((item) => objIds.has(item.objectId));
  return (el?.elementKind as ElementKind) ?? null;
}

function elementForObject(objectId: string, ctx: TraceContext): PhysicsElement | null {
  return ctx.physicsElements.find((item) => item.objectId === objectId) ?? null;
}

function laserWavelengthNm(element: PhysicsElement | undefined): number {
  const params = (element?.kindParams ?? {}) as { centerWavelengthNm?: number };
  return typeof params.centerWavelengthNm === "number" && params.centerWavelengthNm > 0
    ? params.centerWavelengthNm
    : 780;
}

/** Jones-vector helpers used by the visual ray-tracer to mirror the backend
 *  optical_solver's polarisation calculus. Each Jones state is stored as a
 *  4-tuple [Re(Ex), Im(Ex), Re(Ey), Im(Ey)] for cheap copy/equality. The
 *  matrices below match jones_waveplate_matrix / jones_polarizer_matrix in
 *  optical_solver.py one-for-one. */
type JonesTuple = [number, number, number, number];

/** Apply a 2×2 complex matrix to the Jones vector. Matrix is given as
 *  [a, b, c, d] with each entry [re, im]. */
function applyJonesMatrix(
  j: JonesTuple,
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): JonesTuple {
  // ex' = a·ex + b·ey, ey' = c·ex + d·ey
  const exRe = a[0] * j[0] - a[1] * j[1] + b[0] * j[2] - b[1] * j[3];
  const exIm = a[0] * j[1] + a[1] * j[0] + b[0] * j[3] + b[1] * j[2];
  const eyRe = c[0] * j[0] - c[1] * j[1] + d[0] * j[2] - d[1] * j[3];
  const eyIm = c[0] * j[1] + c[1] * j[0] + d[0] * j[3] + d[1] * j[2];
  return [exRe, exIm, eyRe, eyIm];
}

/** Real-valued 2×2 rotation: matrix entries [c, s, -s, c]. */
function rotJones(j: JonesTuple, angleRad: number): JonesTuple {
  const co = Math.cos(angleRad);
  const si = Math.sin(angleRad);
  return applyJonesMatrix(j, [co, 0], [si, 0], [-si, 0], [co, 0]);
}

/** Apply a waveplate with given retardance (in λ — 0.5 = HWP, 0.25 = QWP)
 *  and fast-axis angle (degrees). Mirrors backend jones_waveplate_matrix:
 *  R(-θ) · diag(1, e^iφ) · R(θ). For an HWP at angle θ acting on linear
 *  polarisation along Ex this rotates the output by 2θ. */
function applyWaveplate(j: JonesTuple, retardanceLambda: number, fastAxisDeg: number): JonesTuple {
  const phi = 2 * Math.PI * retardanceLambda;
  const theta = (fastAxisDeg * Math.PI) / 180;
  const co = Math.cos(theta);
  const si = Math.sin(theta);
  const eRe = Math.cos(phi);
  const eIm = Math.sin(phi);
  // a = co² + e·si²; b = co·si - e·co·si; c = b; d = si² + e·co²
  const a: [number, number] = [co * co + eRe * si * si, eIm * si * si];
  const b: [number, number] = [co * si - eRe * co * si, -eIm * co * si];
  const c: [number, number] = b;
  const d: [number, number] = [si * si + eRe * co * co, eIm * co * co];
  return applyJonesMatrix(j, a, b, c, d);
}

/** Apply a linear polarizer with finite extinction. Mirrors backend
 *  jones_polarizer_matrix exactly. */
function applyPolarizer(
  j: JonesTuple,
  transmissionAxisDeg: number,
  transmission: number,
  extinctionDb: number,
): JonesTuple {
  const theta = (transmissionAxisDeg * Math.PI) / 180;
  const co = Math.cos(theta);
  const si = Math.sin(theta);
  const leak = Math.pow(10, -extinctionDb / 10);
  const passAmp = Math.sqrt(Math.max(0, transmission));
  const leakAmp = Math.sqrt(Math.max(0, transmission * leak));
  const a: [number, number] = [co * co * passAmp + si * si * leakAmp, 0];
  const b: [number, number] = [co * si * (passAmp - leakAmp), 0];
  return applyJonesMatrix(j, a, b, b, [si * si * passAmp + co * co * leakAmp, 0]);
}

/** Idealised PBS visualisation. The output **direction** is FIXED — the
 *  transmitted branch is always pure P (linear @ axis°) and the reflected
 *  branch is always pure S (linear @ axis+90°), regardless of input. The
 *  per-branch power factor is given by Malus-law projection × `transmission`:
 *    transFraction = |Re(P-projection)|² × T
 *    reflFraction = |S-projection|² × T
 *  so a pure-P input transmits 100% / reflects 0%, pure-S the opposite,
 *  45° linear splits 50/50. `extinctionDb` is intentionally ignored — the
 *  backend solver keeps the finite-extinction leak for accurate Run-Solver
 *  power numbers, but for visual labels we want clean "linear @ 0°" /
 *  "linear @ 90°" badges. */
function applyPolarisingPBS(
  j: JonesTuple,
  transmissionAxisDeg: number,
  transmission: number,
  _extinctionDb: number,
): {
  transmitted: JonesTuple;
  reflected: JonesTuple;
  transFraction: number;
  reflFraction: number;
} {
  const theta = (transmissionAxisDeg * Math.PI) / 180;
  const into = rotJones(j, -theta);
  const T = Math.max(0, transmission);
  // Intensity along PBS-local P (Ex) and S (Ey) axes.
  const ipI = into[0] * into[0] + into[1] * into[1];
  const isI = into[2] * into[2] + into[3] * into[3];
  const inI = ipI + isI;
  const transFraction = inI > 1e-30 ? (ipI / inI) * T : 0;
  const reflFraction = inI > 1e-30 ? (isI / inI) * T : 0;
  // Output direction: always unit vectors along P (transmitted) / S
  // (reflected), expressed in the BEAM-LOCAL Jones frame. Independent of
  // input — the polarisation BADGE always reads "linear @ θ°" / "linear
  // @ (θ+90)°" while the power factor encodes the actual amplitude.
  const cT = Math.cos(theta);
  const sT = Math.sin(theta);
  const transmitted: JonesTuple = [cT, 0, sT, 0];     // unit linear @ θ
  const reflected: JonesTuple = [-sT, 0, cT, 0];      // unit linear @ θ + 90°
  return { transmitted, reflected, transFraction, reflFraction };
}

/** Initial Jones state from the laser's kindParams.polarization. */
function laserJones(element: PhysicsElement): JonesTuple {
  const p = (element.kindParams ?? {}) as {
    polarization?: { exRe?: number; exIm?: number; eyRe?: number; eyIm?: number };
  };
  const pol = p.polarization ?? {};
  const exRe = typeof pol.exRe === "number" ? pol.exRe : 1;
  const exIm = typeof pol.exIm === "number" ? pol.exIm : 0;
  const eyRe = typeof pol.eyRe === "number" ? pol.eyRe : 0;
  const eyIm = typeof pol.eyIm === "number" ? pol.eyIm : 0;
  // Normalize to unit intensity so downstream Malus/extinction maths works.
  const norm = Math.sqrt(exRe * exRe + exIm * exIm + eyRe * eyRe + eyIm * eyIm);
  if (norm < 1e-12) return [1, 0, 0, 0];
  return [exRe / norm, exIm / norm, eyRe / norm, eyIm / norm];
}

function normalizeJones(j: JonesTuple, fallback: JonesTuple = [1, 0, 0, 0]): JonesTuple {
  const norm = Math.sqrt(j[0] ** 2 + j[1] ** 2 + j[2] ** 2 + j[3] ** 2);
  if (norm < 1e-12) return fallback;
  return [j[0] / norm, j[1] / norm, j[2] / norm, j[3] / norm];
}

/** Polarization of the seed beam at intercept_in. Used for the input
 *  acceptance check and for the backward ASE leak direction (which exits
 *  the same facet as the seed enters). */
function taInputJones(element: PhysicsElement): JonesTuple {
  const params = (element.kindParams ?? {}) as {
    inputPolarization?: { exRe?: number; exIm?: number; eyRe?: number; eyIm?: number };
  };
  const pol = params.inputPolarization ?? {};
  return normalizeJones([
    typeof pol.exRe === "number" ? pol.exRe : 0,
    typeof pol.exIm === "number" ? pol.exIm : 0,
    typeof pol.eyRe === "number" ? pol.eyRe : 1,
    typeof pol.eyIm === "number" ? pol.eyIm : 0,
  ], [0, 0, 1, 0]);
}

/** Polarization of the amplified beam emitted at intercept_out. Most TA
 *  chips lock the output to a specific linear state (the gain medium has
 *  a TM preference), independent of the seed state. The user configures
 *  this via kindParams.outputPolarization in the panel; if absent, fall
 *  back to inputPolarization so an unconfigured chip behaves like before
 *  this wiring landed. */
function taOutputJones(element: PhysicsElement): JonesTuple {
  const params = (element.kindParams ?? {}) as {
    outputPolarization?: { exRe?: number; exIm?: number; eyRe?: number; eyIm?: number };
    inputPolarization?: { exRe?: number; exIm?: number; eyRe?: number; eyIm?: number };
  };
  const pol = params.outputPolarization ?? params.inputPolarization ?? {};
  return normalizeJones([
    typeof pol.exRe === "number" ? pol.exRe : 0,
    typeof pol.exIm === "number" ? pol.exIm : 0,
    typeof pol.eyRe === "number" ? pol.eyRe : 1,
    typeof pol.eyIm === "number" ? pol.eyIm : 0,
  ], [0, 0, 1, 0]);
}

function jonesOverlap(a: JonesTuple, b: JonesTuple): number {
  const an = normalizeJones(a);
  const bn = normalizeJones(b);
  const re = an[0] * bn[0] + an[1] * bn[1] + an[2] * bn[2] + an[3] * bn[3];
  const im = an[1] * bn[0] - an[0] * bn[1] + an[3] * bn[2] - an[2] * bn[3];
  return Math.max(0, Math.min(1, re * re + im * im));
}

function taInputSpatialMode(element: PhysicsElement): BeamState {
  const params = (element.kindParams ?? {}) as {
    centerWavelengthNm?: number;
    inputSpatialModeX?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number } | null;
    inputSpatialModeY?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number } | null;
    backwardSpatialModeX?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number } | null;
    backwardSpatialModeY?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number } | null;
    outputSpatialModeX?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
    outputSpatialModeY?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
  };
  const x = params.inputSpatialModeX ?? params.backwardSpatialModeX ?? params.outputSpatialModeX;
  const y = params.inputSpatialModeY ?? params.backwardSpatialModeY ?? params.outputSpatialModeY;
  const wxUm = x?.waistUm ?? y?.waistUm ?? 100;
  const wyUm = y?.waistUm ?? x?.waistUm ?? 100;
  const mxSq = x?.mSquared ?? y?.mSquared ?? 1;
  const mySq = y?.mSquared ?? x?.mSquared ?? 1;
  const wxZ = x?.waistZOffsetMm ?? 0;
  const wyZ = y?.waistZOffsetMm ?? 0;
  return {
    waist0Um: 0.5 * (wxUm + wyUm),
    waistZUm: 1000 * 0.5 * (wxZ + wyZ),
    mSquared: 0.5 * (mxSq + mySq),
    wavelengthNm: typeof params.centerWavelengthNm === "number" ? params.centerWavelengthNm : 780,
  };
}

function circularModeOverlap(seedRadiusUm: number, targetRadiusUm: number): number {
  if (seedRadiusUm <= 0 || targetRadiusUm <= 0) return 0;
  const numerator = 2 * seedRadiusUm * targetRadiusUm;
  const denominator = seedRadiusUm * seedRadiusUm + targetRadiusUm * targetRadiusUm;
  const fieldOverlap = numerator / Math.max(denominator, 1e-30);
  return Math.max(0, Math.min(1, fieldOverlap * fieldOverlap));
}

function interpolateTaGain(
  samples: Array<{ inputPowerMw: number; driveCurrentMa: number; forwardPowerMw: number; backwardPowerMw: number }>,
  inputPowerMw: number,
  driveCurrentMa: number,
): { forwardMw: number; backwardMw: number } | null {
  if (!samples.length) return null;
  const inputMin = Math.min(...samples.map((s) => s.inputPowerMw));
  const inputMax = Math.max(...samples.map((s) => s.inputPowerMw));
  const driveMin = Math.min(...samples.map((s) => s.driveCurrentMa));
  const driveMax = Math.max(...samples.map((s) => s.driveCurrentMa));
  const inputScale = Math.max(inputMax - inputMin, 1);
  const driveScale = Math.max(driveMax - driveMin, 1);
  const weighted = samples
    .map((s) => {
      const di = (inputPowerMw - s.inputPowerMw) / inputScale;
      const dc = (driveCurrentMa - s.driveCurrentMa) / driveScale;
      const d2 = di * di + dc * dc;
      return { sample: s, weight: 1 / Math.max(d2, 1e-9) };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);
  const wSum = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (wSum <= 0) return null;
  return {
    forwardMw: weighted.reduce((sum, item) => sum + item.sample.forwardPowerMw * item.weight, 0) / wSum,
    backwardMw: weighted.reduce((sum, item) => sum + item.sample.backwardPowerMw * item.weight, 0) / wSum,
  };
}

function saturatedTaPower(params: {
  smallSignalGainDb?: number;
  saturationPowerMw?: number;
  ase?: { powerMw?: number };
}, inputPowerMw: number): number {
  const gainDb = typeof params.smallSignalGainDb === "number" ? params.smallSignalGainDb : 30;
  const pSat = typeof params.saturationPowerMw === "number" && params.saturationPowerMw > 0
    ? params.saturationPowerMw
    : 500;
  const g0 = 10 ** (gainDb / 10);
  const pIn = Math.max(inputPowerMw, 1e-12);
  const ampMw = (pSat * g0 * pIn) / (pSat + (g0 - 1) * pIn);
  return ampMw + Math.max(0, params.ase?.powerMw ?? 0);
}

function bestTaSeedCoupling(
  segments: TraceSegment[],
  taObjectId: string,
  inputOrigin: THREE.Vector3,
  inputAxis: THREE.Vector3,
  inputMode: BeamState,
  inputPol: JonesTuple,
  acceptanceRadiusMm: number,
): TraceSegment["taSeedCoupling"] | null {
  const axis = inputAxis.clone().normalize();
  let best: TraceSegment["taSeedCoupling"] | null = null;
  for (const seg of segments) {
    if (seg.sourceObjectId === taObjectId) continue;
    const seedDir = seg.endThree.clone().sub(seg.startThree);
    if (seedDir.lengthSq() < 1e-12) continue;
    seedDir.normalize();
    if (seedDir.dot(axis) > -0.985) continue;
    const distanceToInputMm = seg.endThree.distanceTo(inputOrigin) * 100;
    if (distanceToInputMm > acceptanceRadiusMm) continue;
    const rawSeedPowerMw = Math.max(0, seg.nominalPowerMwAtSource * seg.powerFactorAtStart);
    if (rawSeedPowerMw <= 0) continue;
    const seedEndZUm = (seg.pathLengthFromSourceMmAtStart + seg.lengthMm) * 1000;
    const seedRadiusUm = gaussianWaistAtZ(seedEndZUm, seg.beamMode);
    const targetRadiusUm = gaussianWaistAtZ(0, inputMode);
    const modeOverlap = circularModeOverlap(seedRadiusUm, targetRadiusUm);
    const polarizationOverlap = jonesOverlap(seg.polarizationAtStart, inputPol);
    const effectiveSeedPowerMw = rawSeedPowerMw * modeOverlap * polarizationOverlap;
    const candidate = {
      rawSeedPowerMw,
      effectiveSeedPowerMw,
      modeOverlap,
      polarizationOverlap,
      distanceToInputMm,
      seedSourceObjectId: seg.sourceObjectId,
      seedBranch: seg.branch,
    };
    if (
      best === null ||
      candidate.effectiveSeedPowerMw > best.effectiveSeedPowerMw ||
      (candidate.effectiveSeedPowerMw === best.effectiveSeedPowerMw &&
        candidate.distanceToInputMm < best.distanceToInputMm)
    ) {
      best = candidate;
    }
  }
  return best;
}

function reflectDirection(incoming: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 {
  const n = normal.clone().normalize();
  // Make the normal point back toward the incoming ray (handles back-face hits).
  if (n.dot(incoming) > 0) n.negate();
  const dot = incoming.dot(n);
  return incoming.clone().sub(n.clone().multiplyScalar(2 * dot)).normalize();
}

function aomTraversalFromRay(
  obj: SceneObject | undefined,
  ctx: TraceContext,
  dir: THREE.Vector3,
): { sign: AomTraversalSign; entryPortId: "intercept_in" | "intercept_out" } {
  if (!obj) return { sign: 1, entryPortId: "intercept_in" };
  const component = ctx.components.find((c) => c.id === obj.componentId);
  const asset = component?.asset3dId
    ? ctx.assets.find((a) => a.id === component.asset3dId)
    : undefined;
  const inAnchor = asset?.anchors?.find((a) => a.id === "intercept_in");
  const outAnchor = asset?.anchors?.find((a) => a.id === "intercept_out");
  const inBody = inAnchor?.positionMmBodyLocal;
  const outBody = outAnchor?.positionMmBodyLocal;
  if (!inBody || !outBody) return { sign: 1, entryPortId: "intercept_in" };

  const bBody = {
    x: outBody.x - inBody.x,
    y: outBody.y - inBody.y,
    z: outBody.z - inBody.z,
  };
  if (Math.hypot(bBody.x, bBody.y, bBody.z) < 1e-6) {
    return { sign: 1, entryPortId: "intercept_in" };
  }
  const bWorld = bodyLocalDirToWorldThree(bBody, obj).normalize();
  const sign: AomTraversalSign = dir.dot(bWorld) >= 0 ? 1 : -1;
  return {
    sign,
    entryPortId: sign > 0 ? "intercept_in" : "intercept_out",
  };
}

function traceOneRay(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  depth: number,
  branch: TraceBranch,
  ctx: TraceContext,
  ignoreObjectId: string | null,
  wavelengthNm: number,
  maxLengthMm: number,
  maxBounces: number,
  mode: BeamState,
  pathLengthSoFarMm: number,
  sourceComponentId: string,
  powerFactor: number,
  polarization: JonesTuple,
  nominalPowerMwAtSource: number,
  emissionKey: TraceSegment["emissionKey"],
  emitterObjectId: string,
  taSeedCoupling?: TraceSegment["taSeedCoupling"],
): TraceSegment[] {
  if (depth > maxBounces) return [];
  if (direction.lengthSq() === 0) return [];

  const dir = direction.clone().normalize();
  const raycaster = new THREE.Raycaster(origin.clone(), dir, 0, mmToThree(maxLengthMm));

  // Filter out the object we're emerging from so the ray doesn't re-hit itself.
  const targets = ignoreObjectId
    ? ctx.targetMeshes.filter((mesh) => String(mesh.userData.objectId) !== ignoreObjectId)
    : ctx.targetMeshes;

  const hits = raycaster.intersectObjects(targets, false);
  const hit = hits.length > 0 ? hits[0] : null;

  if (!hit) {
    const endThree = origin.clone().add(dir.clone().multiplyScalar(mmToThree(maxLengthMm)));
    const startUm = pathLengthSoFarMm * 1000;
    const endUm = (pathLengthSoFarMm + maxLengthMm) * 1000;
    return [
      {
        startThree: origin.clone(),
        endThree,
        componentIdHit: null,
        hitObjectId: null,
        sourceObjectId: ignoreObjectId ?? "",
        branch,
        depth,
        lengthMm: maxLengthMm,
        wavelengthNm,
        waistAtStartUm: gaussianWaistAtZ(startUm, mode),
        waistAtEndUm: gaussianWaistAtZ(endUm, mode),
        sourceComponentId,
        pathLengthFromSourceMmAtStart: pathLengthSoFarMm,
        powerFactorAtStart: powerFactor,
        polarizationAtStart: polarization,
        beamMode: { ...mode },
        nominalPowerMwAtSource,
        taSeedCoupling,
        emissionKey,
        emitterObjectId,
      },
    ];
  }

  const hitPoint = hit.point.clone();
  const hitObjectId = String(hit.object.userData.objectId ?? "");
  const hitComponentId = String(hit.object.userData.componentId ?? "");
  const lengthThree = origin.distanceTo(hitPoint);
  const segLengthMm = lengthThree * 100; // mmToThree divides by 100; reverse it
  const startUm = pathLengthSoFarMm * 1000;
  const endUm = (pathLengthSoFarMm + segLengthMm) * 1000;
  const segment: TraceSegment = {
    startThree: origin.clone(),
    endThree: hitPoint,
    componentIdHit: hitComponentId,
    hitObjectId,
    sourceObjectId: ignoreObjectId ?? "",
    branch,
    depth,
    lengthMm: segLengthMm,
    wavelengthNm,
    waistAtStartUm: gaussianWaistAtZ(startUm, mode),
    waistAtEndUm: gaussianWaistAtZ(endUm, mode),
    sourceComponentId,
    pathLengthFromSourceMmAtStart: pathLengthSoFarMm,
    powerFactorAtStart: powerFactor,
    polarizationAtStart: polarization,
    beamMode: { ...mode },
    nominalPowerMwAtSource,
    taSeedCoupling,
    emissionKey,
    emitterObjectId,
  };
  const segments: TraceSegment[] = [segment];
  const newPathMm = pathLengthSoFarMm + segLengthMm;

  const kind = elementKindFor(hitComponentId, ctx);

  if (kind === null || ABSORBING_KINDS.has(kind)) {
    // Stop — either an unknown component (treat as solid) or an absorber.
    return segments;
  }

  // Compute world-space surface normal at the hit.
  const localNormal = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 0, 1);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
  const worldNormal = localNormal.applyMatrix3(normalMatrix).normalize();

  if (REFLECTING_KINDS.has(kind)) {
    const reflectedDir = reflectDirection(dir, worldNormal);
    const newOrigin = hitPoint.clone().add(reflectedDir.clone().multiplyScalar(RAY_EPS_THREE));
    // Mirror reflectivity (default 0.99) attenuates power. Polarisation
    // assumed unchanged by the metallic mirror (good approximation for
    // protected silver / gold; not strictly true but close for the visual).
    const oe = elementForObject(hitObjectId, ctx);
    const refl = Number(((oe?.kindParams ?? {}) as { reflectivity?: number }).reflectivity);
    const r = Number.isFinite(refl) ? Math.max(0, Math.min(1, refl)) : 0.99;
    segments.push(
      ...traceOneRay(
        newOrigin,
        reflectedDir,
        depth + 1,
        "reflected",
        ctx,
        hitObjectId,
        wavelengthNm,
        maxLengthMm,
        maxBounces,
        mode,
        newPathMm,
        sourceComponentId,
        powerFactor * r,
        polarization,
        nominalPowerMwAtSource,
        emissionKey,
        emitterObjectId,
        taSeedCoupling,
      ),
    );
    return segments;
  }

  if (SPLITTING_KINDS.has(kind)) {
    // Transmitted continues through. Reflected bounces off the INTERNAL 45°
    // coating, NOT off the cube's outer mesh face — the outer face's normal
    // is along the beam direction, which would back-reflect the beam and
    // break the chain. Read the coating normal from the OE's kindParams (in
    // SceneObject local frame), rotate it into world coords using the same
    // YXZ Euler convention as transformUtils.applyObjectTransform, then
    // reflect against it.
    // V2 Phase 6 (alembic 0032) moved the coating normal from
    // PhysicsElement.kindParams.coatingNormalBodyLocal into
    // SceneObject.properties.anchorBindings[opticalSurface].payload.normalBodyLocal.
    // Read it from the binding first; fall back to kindParams (Phase 5 name
    // then legacy name) for un-migrated rows. Without this V2 read path
    // every PBS / beam-splitter created post-migration has `coating ===
    // undefined`, falls back to `worldNormal` (the cube's outer face
    // normal, which is parallel to the beam), and the reflected branch
    // back-reflects 180° onto the incident axis — visually no reflection.
    const hitObj = ctx.objects.find((o) => o.id === hitObjectId);
    type SurfaceBinding = {
      kind?: string;
      payload?: { normalBodyLocal?: number[] };
    };
    const bindings = (hitObj?.properties as { anchorBindings?: SurfaceBinding[] } | undefined)?.anchorBindings;
    const surfaceBinding = Array.isArray(bindings)
      ? bindings.find((b) => b?.kind === "opticalSurface" && Array.isArray(b.payload?.normalBodyLocal))
      : undefined;
    const bindingNormal = surfaceBinding?.payload?.normalBodyLocal as number[] | undefined;

    const oe = elementForObject(hitObjectId, ctx);
    const kp = oe?.kindParams as { coatingNormalBodyLocal?: number[]; coatingNormalLocal?: number[] } | undefined;
    const coating = bindingNormal ?? kp?.coatingNormalBodyLocal ?? kp?.coatingNormalLocal;
    let coatingNormalWorld: THREE.Vector3 | null = null;
    if (Array.isArray(coating) && coating.length >= 3 && hitObj) {
      coatingNormalWorld = bodyLocalDirToWorldThree(
        { x: coating[0], y: coating[1], z: coating[2] },
        hitObj,
      ).normalize();
    }
    const reflNormal = coatingNormalWorld ?? worldNormal;
    const transmittedDir = dir.clone();
    const reflectedDir = reflectDirection(dir, reflNormal);
    // Split point = where the ray actually intersects the PBS diagonal
    // coating PLANE (a real reflective surface inside the cube). The plane
    // passes through cubeCenter with normal = reflNormal (already in world
    // frame). Solving (origin + t·dir − cubeCenter)·n = 0:
    //   t = ((cubeCenter − origin) · n) / (dir · n)
    // gives the geometric intersection. This is physically correct: the
    // reflected ray bounces off the coating at this exact point, just like
    // a mirror — not at "some approximation of cube centre". The
    // transmitted ray also passes through the coating at the same point
    // (as it must, since the two branches share an interface). When PBS
    // is dragged off-axis the intersection moves along the ray
    // accordingly; geometry stays consistent with the visible cube.
    const cubeBox = new THREE.Box3().setFromObject(hit.object);
    const cubeCenter = cubeBox.isEmpty()
      ? hitPoint.clone()
      : cubeBox.getCenter(new THREE.Vector3());
    let splitPoint: THREE.Vector3;
    if (cubeBox.isEmpty()) {
      splitPoint = hitPoint.clone();
    } else {
      const denom = dir.dot(reflNormal);
      // dir · n ≈ 0 means the ray is parallel to the coating (grazing
      // incidence) — fall back to projecting cubeCenter onto the ray so
      // we don't divide by zero. In a real PBS this never happens at
      // useful incidences, but the guard keeps the trace stable.
      if (Math.abs(denom) < 1e-6) {
        const tAlongRay = cubeCenter.clone().sub(origin).dot(dir);
        splitPoint = origin.clone().add(dir.clone().multiplyScalar(tAlongRay));
      } else {
        const tHit = cubeCenter.clone().sub(origin).dot(reflNormal) / denom;
        splitPoint = origin.clone().add(dir.clone().multiplyScalar(tHit));
      }
      const tFromOrigin = splitPoint.clone().sub(origin).dot(dir);
      segment.endThree = splitPoint;
      segment.lengthMm = tFromOrigin * 100;
      segment.waistAtEndUm = gaussianWaistAtZ(
        (pathLengthSoFarMm + segment.lengthMm) * 1000,
        mode,
      );
    }
    const branchPathMm = pathLengthSoFarMm + segment.lengthMm;
    const transOrigin = splitPoint.clone().add(transmittedDir.clone().multiplyScalar(RAY_EPS_THREE));
    const reflOrigin = splitPoint.clone().add(reflectedDir.clone().multiplyScalar(RAY_EPS_THREE));

    const params = (oe?.kindParams ?? {}) as {
      splitRatioTransmitted?: number;
      transmission?: number;
      polarizing?: boolean;
      // Phase 5: new + legacy.
      transmissionAxisDegBeamLocal?: number;
      transmissionAxisDeg?: number;
      extinctionRatioDb?: number;
    };
    const tx = Number.isFinite(params.transmission ?? NaN)
      ? Math.max(0, Math.min(1, params.transmission as number))
      : 0.99;
    let transPol = polarization;
    let reflPol = polarization;
    let transFactor: number;
    let reflFactor: number;
    if (params.polarizing === true) {
      // Polarising PBS — output direction is FIXED at P-axis (transmitted)
      // / S-axis (reflected); per-branch power = Malus-law projection × T.
      // Even when reflected has zero amplitude (pure-P input), the badge
      // still reads "linear @ 90°" since the OUTPUT direction is intrinsic
      // to the optic, not the input.
      const split = applyPolarisingPBS(
        polarization,
        // Phase 5: prefer the new beam-frame-suffixed key.
        params.transmissionAxisDegBeamLocal ?? params.transmissionAxisDeg ?? 0,
        tx,
        params.extinctionRatioDb ?? 30,
      );
      transFactor = powerFactor * split.transFraction;
      reflFactor = powerFactor * split.reflFraction;
      transPol = split.transmitted;
      reflPol = split.reflected;
    } else {
      // Non-polarising BS: ratio split, polarisation unchanged on both arms.
      const tRatio = Number.isFinite(params.splitRatioTransmitted ?? NaN)
        ? Math.max(0, Math.min(1, params.splitRatioTransmitted as number))
        : 0.5;
      transFactor = powerFactor * tRatio * tx;
      reflFactor = powerFactor * (1 - tRatio) * tx;
    }
    segments.push(
      ...traceOneRay(
        transOrigin,
        transmittedDir,
        depth + 1,
        "transmitted",
        ctx,
        hitObjectId,
        wavelengthNm,
        maxLengthMm,
        maxBounces,
        mode,
        branchPathMm,
        sourceComponentId,
        transFactor,
        transPol,
        nominalPowerMwAtSource,
        emissionKey,
        emitterObjectId,
        taSeedCoupling,
      ),
    );
    segments.push(
      ...traceOneRay(
        reflOrigin,
        reflectedDir,
        depth + 1,
        "reflected",
        ctx,
        hitObjectId,
        wavelengthNm,
        maxLengthMm,
        maxBounces,
        mode,
        branchPathMm,
        sourceComponentId,
        reflFactor,
        reflPol,
        nominalPowerMwAtSource,
        emissionKey,
        emitterObjectId,
        taSeedCoupling,
      ),
    );
    return segments;
  }

  if (kind === "fiber") {
    // Fiber patch-cable dispatch (2026-05-11): when a beam hits a fiber,
    // figure out which end (A=intercept_in or B=intercept_out) was hit,
    // compute coupling efficiency at that face, propagate through the
    // cable (Fresnel both faces + length attenuation), and emit a new
    // beam from the OPPOSITE end along that end's outward direction.
    //
    // Simplified MVP — not yet wired:
    //   - Bend loss (Marcuse curvature integral along the spline)
    //   - Polarization-maintaining slow-axis projection
    //   - Multi-mode mode-mixing scrambler
    //   - PMD / GVD
    // These all roll up into η_mode for now; future iterations can pull
    // each out into its own factor with per-segment debug metadata.
    const oe = elementForObject(hitObjectId, ctx);
    const obj = ctx.objects.find((o) => o.id === hitObjectId);
    const component = obj ? ctx.components.find((c) => c.id === obj.componentId) : undefined;
    const asset = component?.asset3dId
      ? ctx.assets.find((a) => a.id === component.asset3dId)
      : undefined;
    if (!obj || !asset || !oe) return segments;

    type FiberNodePersist = {
      posMm: [number, number, number];
      handleInMm?: [number, number, number];
      handleOutMm?: [number, number, number];
    };
    type FiberKindParams = {
      endA?: { modeFieldDiameterUm?: number; fresnelResidual?: number; glassIndexAtDesignLambda?: number };
      endB?: { modeFieldDiameterUm?: number; fresnelResidual?: number; glassIndexAtDesignLambda?: number };
      fiberType?: "single_mode" | "polarization_maintaining" | "multi_mode";
      designWavelengthNm?: number;
      attenuationCurve?: Array<{ wavelengthNm: number; dbPerKm: number }>;
    };
    const fParams = (oe.kindParams ?? {}) as FiberKindParams;
    const endA = fParams.endA ?? {};
    const endB = fParams.endB ?? {};

    // Compute fiber port poses DIRECTLY from the spline (2026-05-12 fix).
    // The shared `primitive_box` Asset3D that fiber components reference
    // carries anchors authored for OTHER components — at the time of this
    // fix the anchors on the asset were (0, ±55, 0) belonging to some
    // isolator/box-shaped element. The fiber's actual optical port lives
    // at `node + outward · FIBER_FERRULE_TIP_MM`, where outward = -handle
    // at each end (or neighbour-segment fallback) per
    // `endpointOutwardBody`. Bypassing `asset.anchors.find(...)` entirely
    // for fiber kind keeps the runtime stable when the shared-asset
    // anchor data drifts.
    const objProps = (obj.properties ?? {}) as { fiberNodes?: FiberNodePersist[] };
    const compProps = (component?.properties ?? {}) as { fiberNodes?: FiberNodePersist[] };
    const fiberNodes =
      (objProps.fiberNodes && objProps.fiberNodes.length >= 2)
        ? objProps.fiberNodes
        : compProps.fiberNodes;
    if (!fiberNodes || fiberNodes.length < 2) return segments;

    const outwardA = endpointOutwardBody(fiberNodes, "A");
    const outwardB = endpointOutwardBody(fiberNodes, "B");
    const nodeA = fiberNodes[0].posMm;
    const nodeB = fiberNodes[fiberNodes.length - 1].posMm;
    const inBody = {
      x: nodeA[0] + outwardA[0] * FIBER_FERRULE_TIP_MM,
      y: nodeA[1] + outwardA[1] * FIBER_FERRULE_TIP_MM,
      z: nodeA[2] + outwardA[2] * FIBER_FERRULE_TIP_MM,
    };
    const outBody = {
      x: nodeB[0] + outwardB[0] * FIBER_FERRULE_TIP_MM,
      y: nodeB[1] + outwardB[1] * FIBER_FERRULE_TIP_MM,
      z: nodeB[2] + outwardB[2] * FIBER_FERRULE_TIP_MM,
    };
    const inDirBody = { x: outwardA[0], y: outwardA[1], z: outwardA[2] };
    const outDirBody = { x: outwardB[0], y: outwardB[1], z: outwardB[2] };

    // Body-local position → lab mm → three.js world. `rotateLocalToLab`
    // rotates a body offset by the SceneObject's Euler (Rz·Rx·Ry order);
    // adding `(obj.xMm, obj.yMm, obj.zMm)` finishes the body→lab transform.
    // labMmToThreeAbs maps lab (x, y, z) mm → three (x, z, -y) / 100.
    const labMmToThreeAbs = (lab: { x: number; y: number; z: number }) =>
      new THREE.Vector3(lab.x / 100, lab.z / 100, -lab.y / 100);
    const bodyToLabPos = (b: { x: number; y: number; z: number }) => {
      const r = rotateLocalToLab(
        { x: b.x, y: b.y, z: b.z },
        obj.rxDeg ?? 0, obj.ryDeg ?? 0, obj.rzDeg ?? 0,
      );
      return { x: obj.xMm + r.x, y: obj.yMm + r.y, z: obj.zMm + r.z };
    };
    const inLabPos = bodyToLabPos(inBody);
    const outLabPos = bodyToLabPos(outBody);
    const inThree = labMmToThreeAbs(inLabPos);
    const outThree = labMmToThreeAbs(outLabPos);

    // Determine which end was hit: closer end wins. The other is the exit.
    const distInSq = inThree.distanceToSquared(hitPoint);
    const distOutSq = outThree.distanceToSquared(hitPoint);
    const entryEnd: "A" | "B" = distInSq <= distOutSq ? "A" : "B";
    const exitEnd: "A" | "B" = entryEnd === "A" ? "B" : "A";
    const entryThree = entryEnd === "A" ? inThree : outThree;
    const exitThree = entryEnd === "A" ? outThree : inThree;
    const exitDirBody = entryEnd === "A" ? outDirBody : inDirBody;
    const exitDirWorld = bodyLocalDirToWorldThree(exitDirBody, obj).normalize();

    // Coupling at entry face.
    // η_mode: Marcuse Gaussian overlap. Beam waist at the face: use the
    //   incoming `mode.x/y` (or fallback to a small default). Fiber MFD:
    //   from kindParams.endA.modeFieldDiameterUm.
    const endParams = entryEnd === "A" ? endA : endB;
    const exitParams = exitEnd === "A" ? endA : endB;
    const lambdaNm = wavelengthNm;
    const lambdaM = lambdaNm * 1e-9;
    const mfdEntryUm = endParams.modeFieldDiameterUm ?? 5.3;
    const mfdExitUm = exitParams.modeFieldDiameterUm ?? 5.3;
    const wfEntryM = (mfdEntryUm / 2) * 1e-6;
    const wfExitM  = (mfdExitUm  / 2) * 1e-6;
    // Beam waist at hit — the rayTrace's BeamState is a single isotropic
    // value (waist0Um). MFD overlap is a circular approximation so this
    // is fine for the MVP; astigmatic beams collapse to their average waist.
    const wbUm = mode.waist0Um ?? 100;
    const wbM = wbUm * 1e-6;
    // Lateral offset between beam axis and entry anchor (in three units = 100 mm).
    const offsetThree = hitPoint.clone().sub(entryThree);
    // Project the offset onto the plane perpendicular to the beam direction
    // so we measure perpendicular miss, not along-beam separation.
    const offsetAlong = offsetThree.dot(dir);
    const perpOffsetThree = offsetThree.clone().sub(dir.clone().multiplyScalar(offsetAlong));
    const offsetM = perpOffsetThree.length() * 0.1; // three units (100 mm) → m
    // Tilt angle between beam direction and entry anchor inward normal
    // (anchor outward = -inward; aligned coupling has beam ∥ -outward).
    const entryOutwardWorld = bodyLocalDirToWorldThree(
      entryEnd === "A" ? inDirBody : outDirBody,
      obj,
    ).normalize();
    const cosTilt = -dir.dot(entryOutwardWorld);
    const tiltRad = Math.acos(Math.max(-1, Math.min(1, cosTilt)));
    // η_mode (Marcuse single-mode coupling):
    //   η = (2·w_b·w_f / (w_b² + w_f²))²
    //     · exp(-2·r₀² / (w_b² + w_f²))
    //     · exp(-2·θ² · (π·w_b·w_f / λ)² / (w_b² + w_f²))
    const wb2 = wbM * wbM, wf2 = wfEntryM * wfEntryM, sum = wb2 + wf2;
    const baseEta = sum > 1e-30 ? Math.pow((2 * wbM * wfEntryM) / sum, 2) : 0;
    const offsetExpArg = -2 * offsetM * offsetM / sum;
    const tiltMixedScale = (Math.PI * wbM * wfEntryM / lambdaM);
    const tiltExpArg = -2 * tiltRad * tiltRad * tiltMixedScale * tiltMixedScale / sum;
    const etaMode = baseEta * Math.exp(offsetExpArg + tiltExpArg);

    // Fresnel at entry + exit. Bare PC: R = ((n-1)/(n+1))². AR-coated
    // multiplies by `fresnelResidual` (1.0 = no AR, 0.0 = ideal).
    const nEntry = endParams.glassIndexAtDesignLambda ?? 1.4506;
    const nExit = exitParams.glassIndexAtDesignLambda ?? 1.4506;
    const baseFresnel = (n: number) => Math.pow((n - 1) / (n + 1), 2);
    const Rentry = baseFresnel(nEntry) * (endParams.fresnelResidual ?? 1);
    const Rexit  = baseFresnel(nExit)  * (exitParams.fresnelResidual ?? 1);
    const etaFresnel = (1 - Rentry) * (1 - Rexit);

    // Length attenuation. Arc length ≈ straight-line distance between
    // adjacent nodes (Bezier curvature shortens slightly; the
    // approximation is fine for typical patch cables). α from
    // attenuationCurve at λ, linearly interpolated, clamped at endpoints.
    let arcLengthMm = 0;
    if (fiberNodes && fiberNodes.length >= 2) {
      for (let i = 0; i < fiberNodes.length - 1; i++) {
        const a = fiberNodes[i].posMm, b = fiberNodes[i + 1].posMm;
        arcLengthMm += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
    }
    const arcLengthKm = arcLengthMm * 1e-6;
    const interpDbPerKm = (() => {
      const curve = (fParams.attenuationCurve ?? []).slice().sort((a, b) => a.wavelengthNm - b.wavelengthNm);
      if (curve.length === 0) return 0;
      if (lambdaNm <= curve[0].wavelengthNm) return curve[0].dbPerKm;
      if (lambdaNm >= curve[curve.length - 1].wavelengthNm) return curve[curve.length - 1].dbPerKm;
      for (let i = 1; i < curve.length; i++) {
        if (lambdaNm <= curve[i].wavelengthNm) {
          const a = curve[i - 1], b = curve[i];
          const t = (lambdaNm - a.wavelengthNm) / (b.wavelengthNm - a.wavelengthNm);
          return a.dbPerKm + (b.dbPerKm - a.dbPerKm) * t;
        }
      }
      return curve[curve.length - 1].dbPerKm;
    })();
    const etaAttenuation = Math.pow(10, -interpDbPerKm * arcLengthKm / 10);

    const etaTotal = Math.max(0, Math.min(1, etaMode * etaFresnel * etaAttenuation));

    // Emit a beam from the EXIT end along the exit-anchor outward
    // direction. Position is bumped by RAY_EPS_THREE so the new ray
    // doesn't immediately re-hit this fiber.
    const newOrigin = exitThree.clone().add(exitDirWorld.clone().multiplyScalar(RAY_EPS_THREE));
    // Output Gaussian: waist sits AT the fiber exit face. Convention:
    // `BeamState.waistZUm` is the cumulative path-length FROM THE
    // ORIGINAL EMITTER at which the waist sits — NOT a local
    // segment-relative coord. The downstream traceOneRay below starts
    // at `pathLengthSoFarMm = newPathMm + arcLengthMm`, so the waist
    // (= fiber exit face) is at exactly that path length. Pre-fix this
    // was set to 0, which made `gaussianWaistAtZ` interpret the waist
    // as being at the laser origin — for a beam ~1 m downstream of the
    // emitter this artificially blew up w(z_lens) to ~100 mm and made
    // a downstream collimating lens see a far-field source instead of
    // a near-field point. M² ≈ 1 for SM/PM (fiber is a spatial filter).
    const downstreamWaistPathUm = (newPathMm + arcLengthMm) * 1000;
    const outputMode: BeamState = {
      waist0Um: mfdExitUm / 2,
      waistZUm: downstreamWaistPathUm,
      mSquared: 1,
      wavelengthNm: mode.wavelengthNm ?? lambdaNm,
    };
    const fiberCouplingMeta = {
      etaMode,
      etaFresnel,
      etaAttenuation,
      etaTotal,
      arcLengthM: arcLengthMm / 1000,
      mfdEntryUm,
      mfdExitUm,
    };
    const downstream = traceOneRay(
      newOrigin,
      exitDirWorld,
      depth + 1,
      "transmitted",
      ctx,
      hitObjectId,
      wavelengthNm,
      maxLengthMm,
      maxBounces,
      outputMode,
      newPathMm + arcLengthMm,
      sourceComponentId,
      powerFactor * etaTotal,
      polarization,
      nominalPowerMwAtSource,
      emissionKey,
      emitterObjectId,
      taSeedCoupling,
    );
    // Attach the coupling breakdown only to the FIRST emitted segment
    // (the one starting at intercept_out). Further downstream segments
    // past other optics shouldn't claim this fiber's coupling — they'd
    // get their own meta if they hit another fiber.
    if (downstream.length > 0) {
      downstream[0] = { ...downstream[0], fiberCoupling: fiberCouplingMeta };
    }
    segments.push(...downstream);
    return segments;
  }

  if (kind === "aom") {
    // Acousto-optic modulator — Bragg diffraction.
    //
    // Physics:
    //   sin θ_B  = λ·f / (2·n·v)              ← Bragg angle
    //   f_d      = f_i ± f                    ← frequency shift on ±1st order
    //   I₁/I₀    = sin²(π·L/(2λ·cosθ_B)·√(2·M₂·P_d/W))   ← efficiency
    //
    // Bidirectional: the beam can enter from EITHER face. The acoustic
    // wave defines the diffraction plane (containing the optical axis
    // and the acoustic-axis vector), so the geometry is independent of
    // which face the beam came in.
    //
    // Output, controlled by `kindParams.diffractionOrder`:
    //   • +1: deflected by +2θ_B (η of incident), zeroth carries (1−η).
    //   • −1: deflected by −2θ_B (η of incident), zeroth carries (1−η).
    //   •  0: RF effectively off — all power stays on the transmitted
    //         path, no ±1st branch is spawned. Use this when the user
    //         wants pass-through (zeroth-order maximised).
    const oe = elementForObject(hitObjectId, ctx);
    // Phase B: centerFreqMhz / rfDrivePowerW are no longer stored on the
    // AOM. Resolve them live from the upstream rf_source channel via the
    // AOM's rf_in `rfCableEndpoints` link (mirrors backend
    // `hydrate_aom_rf_drive`). Orphan AOMs fall back to 80 MHz default
    // and an undefined P_d (closed-form efficiency then takes the
    // baseEfficiency path).
    const upstreamDrive = resolveAomRfDriveFromScene(
      hitObjectId, ctx.objects, ctx.physicsElements,
    );
    const baseParams = (oe?.kindParams ?? {}) as {
      acousticVelocityMPerS?: number;
      refractiveIndex?: number;
      baseEfficiency?: number;
      figureOfMeritM2?: number;       // m²/W
      crystalLengthMm?: number;       // L (acousto-optic interaction length)
      acousticBeamWidthMm?: number;   // W
      rfPowerMaxW?: number;           // safety cap; clamps resolved P_d
      // Phase 5: new frame-suffixed names; legacy names accepted for
      // un-migrated rows.
      acousticAxisBodyLocal?: number[];
      acousticAxisLocal?: number[];
      rfPropagationDirectionBodyLocal?: number[];
      rfPropagationDirectionLocal?: number[];
      diffractionOrder?: number;      // 0, +1, or −1  (selected output order)
      braggAngularAcceptanceMrad?: number;
      maxDiffractionOrder?: number;   // visualize orders -N..+N (default 3)
      sidebandVisibilityThreshold?: number; // skip emitting orders below this fraction (default 0.01)
    };
    const params = {
      ...baseParams,
      centerFreqMhz: upstreamDrive?.frequencyMhz ?? 80,
      rfDrivePowerW: upstreamDrive
        ? Math.min(
            upstreamDrive.drivePowerW,
            baseParams.rfPowerMaxW ?? Number.POSITIVE_INFINITY,
          )
        : undefined,
    } as typeof baseParams & { centerFreqMhz: number; rfDrivePowerW?: number };
    // Coerce to discrete {-1, 0, +1}. Anything else falls back to +1
    // (historical default).
    const orderRaw = params.diffractionOrder;
    const orderSign: -1 | 0 | 1 =
      orderRaw === 0 ? 0 :
      orderRaw === -1 ? -1 :
      1;
    // Phase 7: Bragg θ_B + closed-form sin² efficiency live in
    // optical/kinds/aom/physics.ts so the panel readouts and the
    // ray-tracer can never silently disagree.
    const thetaB = braggAngleRad(params, wavelengthNm);
    const efficiency = diffractionEfficiency(params, wavelengthNm, thetaB);

    // Acoustic axis in WORLD frame. Default: body-local -X for the MT80
    // GLB convention: +Y is laser -> 0th, -X is transducer -> absorber,
    // and +/-Z is perpendicular to the outline drawing.
    const obj = ctx.objects.find((o) => o.id === hitObjectId);
    const traversal = aomTraversalFromRay(obj, ctx, dir);
    // Phase 7.4 fix: with the new two-stage align, the body is re-tilted
    // for state B (entry=intercept_out) so the body-frame Bragg-correct
    // order is the user's selected m WITHOUT flipping for traversal.
    // Pre-7.4 used `effectiveAomOrderForTraversal(orderSign, traversal.sign)`
    // here, which assumed the body's mechanical Bragg tilt was FIXED
    // (state-A orientation regardless of which port is the entry). With
    // re-tilt-per-state align that assumption breaks: state-B m=+1 with
    // the flip lands at body-frame -1, which is +3θ_B off-Bragg from the
    // state-B input pose (input·D2 = +sin θ_B). The matched plan.order
    // is now just `orderSign`, body-frame physical, single source of
    // truth shared with `expectedInputDotD2(m, traversalSign, ...)` at
    // the align side.
    const effectiveOrderSign = orderSign;
    let rfAxisWorld = new THREE.Vector3(0, 1, 0);  // three +Y = lab +Z
    let bodyAxisWorld = dir.clone();
    if (obj) {
      // 2026-05-10: RF direction now lives on the Asset3D as an anchor
      // with id = "rf_direction"; getRfDirectionBodyLocal reads that
      // first and falls back to the legacy kindParams keys.
      const component = ctx.components.find((c) => c.id === obj.componentId);
      const asset = component?.asset3dId
        ? ctx.assets.find((a) => a.id === component.asset3dId)
        : null;
      const rfBodyLocal = getRfDirectionBodyLocal(asset, params)
        ?? { x: -1, y: 0, z: 0 };  // MT80 transducer -> absorber default
      rfAxisWorld = bodyLocalDirToWorldThree(rfBodyLocal, obj).normalize();
      bodyAxisWorld = bodyLocalDirToWorldThree({ x: 1, y: 0, z: 0 }, obj).normalize();
    }

    // Diffracted direction: rotate `dir` by ±2·θ_B (sign = chosen order)
    // around an axis perpendicular to BOTH `dir` and the acoustic axis.
    const rotAxis = new THREE.Vector3().crossVectors(dir, rfAxisWorld);
    const canDiffract = rotAxis.lengthSq() >= 1e-12;
    let braggMismatchMrad = 0;
    let braggAngularFactor = effectiveOrderSign === 0 ? 0 : 1;
    if (!canDiffract) {
      // Beam parallel to acoustic axis (no Bragg interaction possible);
      // emit only the 0th order so the chain doesn't fork pointlessly.
      braggAngularFactor = 0;
    } else {
      rotAxis.normalize();
      if (effectiveOrderSign !== 0) {
        // Off-Bragg detuning. Bragg condition: beam · D2 (= rfAxisWorld)
        // must equal `expectedInputDotD2(orderSign, traversal.sign, θ_B)`.
        // physics.ts owns this sign convention (Phase 7.4 unification —
        // it also drives `expectedDotD2` in alignToLaser), so the
        // ray-tracer's mismatch detection cannot drift from align.
        const dotBA = THREE.MathUtils.clamp(dir.dot(rfAxisWorld), -1, 1);
        const beamAngleFromPerpRad = Math.asin(dotBA);
        const expectedDotD2 = expectedInputDotD2(orderSign, traversal.sign, thetaB);
        const expectedAngleRad = Math.asin(THREE.MathUtils.clamp(expectedDotD2, -1, 1));
        const mismatchRad = beamAngleFromPerpRad - expectedAngleRad;
        const acceptanceRad = Math.max(1e-6, (params.braggAngularAcceptanceMrad ?? 2.0) * 1e-3);
        braggMismatchMrad = mismatchRad * 1e3;
        braggAngularFactor = Math.exp(-((mismatchRad / acceptanceRad) ** 2));
      }
    }

    // Multi-order ray spawn. The 0th and the user-selected ±1 use the
    // asymmetric Bragg model (selected ±1 takes η × angularFactor of
    // the incident; 0th carries the rest; opposite ±1 stays at the
    // 0.1 % suppression floor). Higher orders ±2 ... ±maxOrder use
    // the Raman-Nath J_n²(v) approximation, scaled by angularFactor so
    // they fall off the same way ±1 does as the body rotates off
    // Bragg. Each emitted ray is gated by the visibility threshold
    // (default 1 %) — except 0 and the selected ±1 which always show
    // so the user keeps seeing them even when efficiency drops near
    // zero off-Bragg.
    // Phase RF.8: scrub-time override > static kindParams > 80 MHz default.
    const fMhz =
      ctx.aomFreqOverrideMhz?.get(hitObjectId) ?? params.centerFreqMhz ?? 80;
    const carrierThz = OPTICAL_C_M_PER_S / (wavelengthNm * 1e-9) / 1e12;
    const maxDiffractionOrder = Math.max(
      1,
      Math.min(10, Math.round(params.maxDiffractionOrder ?? 3)),
    );
    const sidebandThreshold = THREE.MathUtils.clamp(
      params.sidebandVisibilityThreshold ?? 0.01,
      0,
      1,
    );
    // Phase-modulation depth v — same source as the panel (see
    // optical/kinds/aom/physics.ts). Falls back to 2·sqrt(η) when
    // M₂/L/W/P_d aren't all set.
    const phaseModDepth = phaseModulationDepth(params, wavelengthNm, thetaB, efficiency);
    const sidebandMeta = (
      order: number,
      angleMrad: number,
      relativeIntensity: number,
    ) => {
      const centerFrequencyThz = carrierThz + order * fMhz * 1e-6;
      const centerWavelengthNm = OPTICAL_C_M_PER_S / (centerFrequencyThz * 1e12) * 1e9;
      return {
        order,
        frequencyOffsetMhz: order * fMhz,
        angleMrad,
        braggMismatchMrad,
        braggAngularFactor,
        relativeIntensity,
        centerFrequencyThz,
        centerWavelengthNm,
        requestedOrder: orderSign,
        matchedOrder: effectiveOrderSign,
        inputTraversalSign: traversal.sign,
        entryPortId: traversal.entryPortId,
      };
    };

    // Compute per-order intensity fractions.
    const fractionForOrder = (n: number): number => {
      if (effectiveOrderSign === 0 || !canDiffract) {
        // RF off (or beam parallel to acoustic): only 0th carries power.
        return n === 0 ? 1 : 0;
      }
      if (n === effectiveOrderSign) {
        return efficiency * braggAngularFactor;
      }
      if (Math.abs(n) === 1) {
        // Opposite ±1 — physically suppressed in true Bragg.
        return 0.001;
      }
      if (n === 0) {
        // Will be filled in below as (1 − sum of all other emitted orders).
        return Number.NaN;
      }
      // |n| ≥ 2: Raman-Nath Bessel approximation, attenuated by the
      // same braggAngularFactor so higher orders also fall off as the
      // AOM rotates off the chosen-order Bragg condition.
      return besselJ(n, phaseModDepth) ** 2 * braggAngularFactor;
    };

    type OrderPlan = { order: number; fraction: number; alwaysShow: boolean };
    const plans: OrderPlan[] = [];
    let nonZeroSum = 0;
    for (let n = -maxDiffractionOrder; n <= maxDiffractionOrder; n++) {
      if (n === 0) continue;
      const f = fractionForOrder(n);
      plans.push({ order: n, fraction: f, alwaysShow: n === effectiveOrderSign });
      nonZeroSum += f;
    }
    // The hybrid model (asymmetric Bragg ±1 + symmetric Bessel ±2..) can
    // sum to >1 at high modulation depth — scale uniformly so power
    // conservation holds and the 0th retains a positive fraction.
    if (nonZeroSum > 1) {
      const scale = 1 / nonZeroSum;
      for (const p of plans) p.fraction *= scale;
      nonZeroSum = 1;
    }
    const zerothFraction = Math.max(0, 1 - nonZeroSum);
    plans.push({ order: 0, fraction: zerothFraction, alwaysShow: true });

    // Sort so 0 comes first then -max..+max (deterministic emission order
    // helps debug-trace readers and keeps panels stable).
    plans.sort((a, b) => a.order - b.order);

    // Bragg interaction point in three.js world frame.
    //
    // Every order (0, ±1, ±2, …) fans out from this point so the
    // sideband plane is anchored to the crystal's effective interaction
    // centre, perpendicular to D3 = D1 × D2 at that pivot. To keep the
    // visual continuous, we ALSO extend the input segment to terminate
    // here (instead of at the entry-face hitPoint) — physically this
    // matches "beam propagates through the crystal volume up to the
    // diffraction region, then splits". With the segment extended, the
    // 0th order continues from the same point along `dir` with no
    // visible offset.
    //
    // Resolution order for the pivot:
    //   1. kindParams.braggInteractionPointMmBodyLocal (asymmetric AOM
    //      override, body-local mm)
    //   2. midpoint of the asset's intercept_in / intercept_out anchors
    //   3. fallback: hitPoint (no extension; preserves prior behaviour
    //      when the asset is missing the port anchors)
    const braggInteractionPointThree: THREE.Vector3 = (() => {
      if (!obj) return hitPoint.clone();
      let pivotBody: { x: number; y: number; z: number } | null = null;
      const overrideRaw = (params as { braggInteractionPointMmBodyLocal?: unknown })
        .braggInteractionPointMmBodyLocal;
      if (Array.isArray(overrideRaw) && overrideRaw.length >= 3) {
        const [px, py, pz] = overrideRaw as number[];
        if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz)) {
          pivotBody = { x: Number(px), y: Number(py), z: Number(pz) };
        }
      }
      if (!pivotBody) {
        const component = ctx.components.find((c) => c.id === obj.componentId);
        const asset = component?.asset3dId
          ? ctx.assets.find((a) => a.id === component.asset3dId)
          : undefined;
        const inAnchor = asset?.anchors?.find((a) => a.id === "intercept_in");
        const outAnchor = asset?.anchors?.find((a) => a.id === "intercept_out");
        const inBody = inAnchor?.positionMmBodyLocal;
        const outBody = outAnchor?.positionMmBodyLocal;
        if (inBody && outBody) {
          pivotBody = {
            x: 0.5 * (inBody.x + outBody.x),
            y: 0.5 * (inBody.y + outBody.y),
            z: 0.5 * (inBody.z + outBody.z),
          };
        }
      }
      if (!pivotBody) return hitPoint.clone();
      const offsetLab = rotateLocalToLab(pivotBody, obj.rxDeg, obj.ryDeg, obj.rzDeg);
      return labToThreeVector([
        obj.xMm + offsetLab.x,
        obj.yMm + offsetLab.y,
        obj.zMm + offsetLab.z,
      ]);
    })();

    // Extend the just-pushed input segment to terminate at the Bragg
    // interaction point's PROJECTION onto the incoming ray, then move the
    // sideband fan pivot to that same projected point.
    //
    // Pre-fix: the segment endpoint was teleported directly to
    // `braggInteractionPointThree` (the body-local anchor midpoint
    // converted to world). When the AOM body is even slightly misaligned
    // with the actual beam axis (e.g., body-center 46 mm above the beam
    // line), this introduced a visible kink: the segment's *displayed*
    // direction `(end - start)` no longer matched the real ray `dir`,
    // and the 0th-order spawn — which uses `dir` — then appeared to
    // bend by tens to hundreds of mrad at the joint.
    //
    // Post-fix: we keep the segment direction strictly along `dir` by
    // projecting the geometric pivot onto the ray (`t = (pivot - origin)·dir`)
    // and using `origin + dir·t` as the new endpoint. The fan still
    // emerges from a single common point (now the projected one), and
    // for an on-axis input the projection equals the pivot exactly, so
    // the visual is unchanged in the aligned case. For a misaligned
    // input, the fan pivot follows the real beam through the body so
    // there's no kink — the user sees the laser pass through the AOM
    // along its actual direction, then the orders fan out from the
    // closest-approach point. */
    let extendedPathMm = newPathMm;
    let braggFanPivotThree = braggInteractionPointThree.clone();
    if (!braggInteractionPointThree.equals(hitPoint)) {
      const extendedSeg = segments[segments.length - 1];
      const tAlongRay = braggInteractionPointThree.clone().sub(origin).dot(dir);
      const projectedEnd = origin.clone().add(dir.clone().multiplyScalar(tAlongRay));
      const extendedLengthThree = origin.distanceTo(projectedEnd);
      const extendedSegLengthMm = extendedLengthThree * 100;
      const extendedEndUm = (pathLengthSoFarMm + extendedSegLengthMm) * 1000;
      extendedSeg.endThree = projectedEnd;
      extendedSeg.lengthMm = extendedSegLengthMm;
      extendedSeg.waistAtEndUm = gaussianWaistAtZ(extendedEndUm, mode);
      extendedPathMm = pathLengthSoFarMm + extendedSegLengthMm;
      braggFanPivotThree = projectedEnd;
    }

    for (const plan of plans) {
      if (!plan.alwaysShow && plan.fraction < sidebandThreshold) continue;
      // Convention (2026-05-11 clarification): the angle between order 0
      // and order m on a screen is m·2·θ_B (≈ m·λ·f/v at small angles),
      // matching standard Bragg-cell deflection. θ_B is the half-angle
      // (`arcsin(λ·f/(2·n·v))`).
      const angleMrad = plan.order * 2 * thetaB * 1e3;
      // Route through `diffractedDirection` (physics.ts single source).
      // The rotation is `+m·2·θ_B` about D3 (= rotAxis); for Bragg-aligned
      // input (alignToLaser places beam·D2 = expectedInputDotD2), the
      // m=±1 output lands symmetric to the input across the D1-D3 plane.
      const rayDir = plan.order === 0
        ? dir.clone()
        : (() => {
            const out = diffractedDirection(
              { x: dir.x, y: dir.y, z: dir.z },
              { x: rotAxis.x, y: rotAxis.y, z: rotAxis.z },
              plan.order,
              thetaB,
            );
            return new THREE.Vector3(out.x, out.y, out.z).normalize();
          })();
      // All orders fan out from the projected Bragg pivot (the foot of
      // the perpendicular from the geometric body-anchor midpoint onto
      // the incoming ray) so they share a single emission point that
      // sits on the actual beam axis. Tiny RAY_EPS_THREE step along
      // the outgoing direction keeps the raycaster from re-hitting the
      // AOM body it just emerged from.
      const newOrigin = braggFanPivotThree
        .clone()
        .add(rayDir.clone().multiplyScalar(RAY_EPS_THREE));
      const branchLabel: TraceBranch =
        plan.order === 0
          ? "transmitted"
          : plan.order === effectiveOrderSign
            ? "reflected"
            : "transmitted";
      const meta = sidebandMeta(plan.order, angleMrad, plan.fraction);
      segments.push(
        ...traceOneRay(
          newOrigin,
          rayDir,
          depth + 1,
          branchLabel,
          ctx,
          hitObjectId,
          wavelengthNm,
          maxLengthMm,
          maxBounces,
          mode,
          extendedPathMm,
          sourceComponentId,
          powerFactor * plan.fraction,
          polarization,
          nominalPowerMwAtSource,
          emissionKey,
          emitterObjectId,
          taSeedCoupling,
        ).map((seg) => ({ ...seg, aomSideband: meta })),
      );
    }
    return segments;
  }

  if (PASSTHROUGH_KINDS.has(kind)) {
    let nextMode = mode;
    let nextPol = polarization;
    const oe = elementForObject(hitObjectId, ctx);
    const oeParams = (oe?.kindParams ?? {}) as {
      focalMm?: number;
      transmission?: number;
      baseEfficiency?: number;
      retardanceLambda?: number;
      // Phase 5: new + legacy.
      fastAxisDegBeamLocal?: number;
      fastAxisDeg?: number;
      transmissionAxisDegBeamLocal?: number;
      transmissionAxisDeg?: number;
      extinctionRatioDb?: number;
    };
    if (kind === "lens_biconvex" || kind === "lens_plano_convex" || kind === "lens_cylindrical") {
      // Apply the thin-lens ABCD on the running Gaussian state.
      const focalMm = typeof oeParams.focalMm === "number" ? oeParams.focalMm : NaN;
      if (Number.isFinite(focalMm)) {
        nextMode = applyThinLens(mode, newPathMm * 1000, focalMm * 1000);
      }
    } else if (kind === "waveplate") {
      // HWP / QWP — rotates polarisation. Mirrors backend apply_waveplate.
      nextPol = applyWaveplate(
        polarization,
        oeParams.retardanceLambda ?? 0.5,
        oeParams.fastAxisDegBeamLocal ?? oeParams.fastAxisDeg ?? 0,
      );
    } else if (kind === "polarizer") {
      nextPol = applyPolarizer(
        polarization,
        oeParams.transmissionAxisDegBeamLocal ?? oeParams.transmissionAxisDeg ?? 0,
        oeParams.transmission ?? 0.95,
        oeParams.extinctionRatioDb ?? 30,
      );
    }
    // Power attenuation: each pass-through optic applies its `transmission`
    // (lens / waveplate / polarizer / fibre coupler / isolator) or
    // `baseEfficiency` (AOM ±1st order) factor. Default 1.0 if neither is
    // present so unknown elements don't silently drop power. For polarizers
    // the power factor is captured by the new |Jones|² (polarizer projects
    // intensity), so use the Jones-norm-squared ratio as the multiplier.
    let tx: number;
    if (kind === "polarizer") {
      const inI = polarization[0] ** 2 + polarization[1] ** 2 + polarization[2] ** 2 + polarization[3] ** 2;
      const outI = nextPol[0] ** 2 + nextPol[1] ** 2 + nextPol[2] ** 2 + nextPol[3] ** 2;
      tx = inI > 1e-12 ? outI / inI : 0;
      // Renormalise Jones for downstream optics
      const norm = Math.sqrt(outI);
      if (norm > 1e-12) {
        nextPol = [nextPol[0] / norm, nextPol[1] / norm, nextPol[2] / norm, nextPol[3] / norm];
      }
    } else {
      const txCandidate = typeof oeParams.transmission === "number"
        ? oeParams.transmission
        : typeof oeParams.baseEfficiency === "number"
          ? oeParams.baseEfficiency
          : 1.0;
      tx = Math.max(0, Math.min(1, txCandidate));
    }
    const newOrigin = hitPoint.clone().add(dir.clone().multiplyScalar(RAY_EPS_THREE));
    segments.push(
      ...traceOneRay(
        newOrigin,
        dir,
        depth + 1,
        branch,
        ctx,
        hitObjectId,
        wavelengthNm,
        maxLengthMm,
        maxBounces,
        nextMode,
        newPathMm,
        sourceComponentId,
        powerFactor * tx,
        nextPol,
        nominalPowerMwAtSource,
        emissionKey,
        emitterObjectId,
        taSeedCoupling,
      ),
    );
    return segments;
  }

  // Unknown emitter kind reached as a target (should not normally happen);
  // stop here.
  return segments;
}

// Exposed for browser-console debugging only — see DigitalTwinViewer.
export function _testReflect(
  inX: number, inY: number, inZ: number,
  nX: number, nY: number, nZ: number,
): { x: number; y: number; z: number } {
  const dir = new THREE.Vector3(inX, inY, inZ);
  const normal = new THREE.Vector3(nX, nY, nZ);
  const r = reflectDirection(dir, normal);
  return { x: r.x, y: r.y, z: r.z };
}

export function traceBeamsFromLasers(input: {
  scene: {
    components: ComponentItem[];
    objects: SceneObject[];
    assets: Asset3D[];
    physicsElements: PhysicsElement[];
  };
  componentGroup: THREE.Group;
  options?: { maxLengthMm?: number; maxBounces?: number };
  /** Phase PB.3 — per-SceneObject gate state at the current scrub time.
   *  When the map contains an entry with `false`, that emitter is
   *  treated as gated off and skipped entirely (so downstream optics
   *  also see no beam). Absent objects render as configured. */
  gateOverrides?: Map<string, boolean>;
  /** Phase RF.8 — per-SceneObject AOM/EOM RF frequency override (MHz)
   *  applied at trace-time. Lets a TimingProgram with `frequencyMhz`
   *  samples drive the visible Bragg deflection angle as the user
   *  scrubs the timeline. Absent objects use kindParams.centerFreqMhz
   *  as before. */
  aomFreqOverrideMhz?: Map<string, number>;
  /** Object ids whose ``device_states.state.power === false`` — the
   *  emitter (laser_source / tapered_amplifier) is treated as physically
   *  off, so it doesn't emit any beam. For TAs this also blocks the
   *  amplified output even if a seed beam arrives upstream (the device
   *  acts as a beam dump when unpowered). */
  poweredOffObjectIds?: Set<string>;
}): TraceSegment[] {
  const { scene, componentGroup } = input;
  const maxLengthMm = input.options?.maxLengthMm ?? DEFAULT_MAX_LENGTH_MM;
  const maxBounces = input.options?.maxBounces ?? DEFAULT_MAX_BOUNCES;
  const gateOverrides = input.gateOverrides;
  const aomFreqOverrideMhz = input.aomFreqOverrideMhz;
  const poweredOffObjectIds = input.poweredOffObjectIds;

  // CRITICAL: refresh world matrices on the entire group BEFORE any bbox /
  // raycast query. Per-mesh updateMatrixWorld(true) only works if the parent
  // chain's matrixWorld is already current, which it isn't for a freshly
  // mounted scene. Without this call, geometry.boundingBox.applyMatrix4(
  // mesh.matrixWorld) returns the LOCAL bbox (matrixWorld defaults to
  // identity), and Raycaster reports no intersections even though the meshes
  // are visually placed.
  componentGroup.updateMatrixWorld(true);

  // Hidden-but-physical opt-in: when an object is filtered out of the
  // current view (visibility / scene-view / session-hidden), the renderer
  // marks every wrapper Group `visible = false` and tags descendants with
  // `userData.physicallyHidden = true`. THREE.Raycaster auto-skips
  // invisible objects, so we'd lose all optical interaction with hidden
  // elements. Toggle them visible JUST for this trace, snapshot which
  // ones we touched, restore at the end. Keeps the visual rendering
  // untouched while letting beams reflect/transmit/split through hidden
  // optics.
  const reHidden: THREE.Object3D[] = [];
  componentGroup.traverse((node) => {
    if (node.userData?.physicallyHidden && !node.visible) {
      node.visible = true;
      reHidden.push(node);
    }
  });
  // Re-update matrices now that previously-hidden subtrees are visible
  // (some THREE versions skip matrix updates on invisible chains).
  componentGroup.updateMatrixWorld(true);

  const targetMeshes: THREE.Object3D[] = [];
  componentGroup.traverse((child) => {
    if (child instanceof THREE.Mesh && child.userData.componentId) {
      targetMeshes.push(child);
    }
  });

  const ctx: TraceContext = {
    componentGroup,
    physicsElements: scene.physicsElements,
    components: scene.components,
    assets: scene.assets,
    objects: scene.objects,
    targetMeshes,
    aomFreqOverrideMhz,
  };

  const assetById = new Map(scene.assets.map((a) => [a.id, a]));
  const sceneObjectById = new Map<string, SceneObject>();
  for (const obj of scene.objects) sceneObjectById.set(obj.id, obj);

  const segments: TraceSegment[] = [];
  const traceElements = [...scene.physicsElements].sort((a, b) => {
    const rank = (e: PhysicsElement) => e.elementKind === "tapered_amplifier" ? 1 : 0;
    return rank(a) - rank(b);
  });
  for (const element of traceElements) {
    if (element.elementKind !== "laser_source" && element.elementKind !== "tapered_amplifier") {
      continue;
    }
    // Per-object optical chain: the PhysicsElement.objectId IS the SceneObject id.
    const obj = sceneObjectById.get(element.objectId);
    if (!obj) continue;
    const component = scene.components.find((c) => c.id === obj.componentId);
    const asset = component?.asset3dId ? assetById.get(component.asset3dId) : undefined;

    // Direction is still derived from the SceneObject's lab-frame rotation —
    // the laser's local +X axis (rotated). Origin, however, is taken from the
    // ACTUAL world bbox of the loaded mesh so the ray exits the visible
    // wireframe's front face, regardless of where the STL's local origin sits
    // relative to the body. Falls back to emissionFromObject when the mesh
    // hasn't been loaded yet.
    const { origin: labOrigin, direction: labDir } = emissionFromObject(obj, asset);
    const dirThree = labDirToThree({ x: labDir.x, y: labDir.y, z: labDir.z });
    // Per-component aperture override: when properties.apertureForwardLocalMm
    // is provided (e.g. BoosTA pro GLB tells us the actual aperture is at
    // Blender (141.4, 0, 49) mm, not at the bbox geometric centre), use it
    // instead of the bbox-front-face fallback. Authored coords are in the
    // GLB's NATIVE Blender frame (X right, Y forward, Z up); meshAperturePoint
    // converts to glTF/three frame and applies the GLB's bbox-centering
    // offset.
    // Phase 6: prefer the new frame-suffixed key (`apertureForwardMmBodyLocal`),
    // fall back to legacy `apertureForwardLocalMm` for un-migrated rows.
    // For tapered_amplifier specifically: phy-edit writes the input-face
    // position to asset.anchors.intercept_in; the legacy properties field
    // is NOT updated by phy edit, so the anchor wins when present. (Lasers
    // have no intercept_in in their kind contract — fall through unchanged.)
    const apertureProps = component?.properties as
      | { apertureForwardMmBodyLocal?: number[]; apertureForwardLocalMm?: number[] }
      | undefined;
    const inAnchorPos = element.elementKind === "tapered_amplifier"
      ? asset?.anchors?.find((a) => a.id === "intercept_in")?.positionMmBodyLocal
      : undefined;
    // Anchor path bypasses meshAperturePoint — anchor positions are
    // wrapper-local (relative to SceneObject origin, same convention the
    // alignment uses), whereas meshAperturePoint interprets its input as
    // GLB-native and adds the bbox-centering offset baked into glbSceneRoot.
    // That mismatch displaced the beam by bboxCenter mm. Compute lab-mm
    // directly: rotated body-local + SceneObject pos → labToThreeVector.
    const apertureForwardLegacy = apertureProps?.apertureForwardMmBodyLocal
      ?? apertureProps?.apertureForwardLocalMm;
    const apertureForwardOrigin: THREE.Vector3 | null = inAnchorPos
      ? (() => {
          const rotated = bodyLocalDirToLabDir(inAnchorPos, obj);
          return labToThreeVector([
            obj.xMm + rotated.x,
            obj.yMm + rotated.y,
            obj.zMm + rotated.z,
          ]);
        })()
      : (apertureForwardLegacy && apertureForwardLegacy.length === 3
        ? meshAperturePoint(componentGroup, obj.componentId, [
            apertureForwardLegacy[0],
            apertureForwardLegacy[1],
            apertureForwardLegacy[2],
          ])
        : null);
    // Mesh-bbox lookup is keyed by componentId (each Three.Mesh has
    // userData.componentId from the renderer). The PhysicsElement is per-
    // object now (alembic 0014), so we resolve via SceneObject.componentId.
    const meshOrigin = meshFrontFaceCenter(componentGroup, obj.componentId, dirThree);
    const originThree =
      apertureForwardOrigin ?? meshOrigin ?? labToThreeVector([labOrigin.x, labOrigin.y, labOrigin.z]);
    const wavelengthNm = laserWavelengthNm(element);

    if (element.elementKind === "laser_source") {
      // Single forward emission (existing behaviour). Source nominal power
      // = LaserSourceParams.nominalPowerMw.
      // Per-instance visualisation override: skip the emission entirely when
      // the user has unticked it on the object panel, so downstream optics
      // don't reflect a beam that's not visible.
      if (!getEmissionVisual(obj, "main").visible) {
        continue;
      }
      // Power off (Instrument Power panel) — laser physically not emitting.
      if (poweredOffObjectIds?.has(obj.id)) {
        continue;
      }
      // Phase PB.3: scrub-time gate cascade — when the user is sampling
      // a TimingProgram / PB channel sequence, gated-off emitters drop
      // their beam (so downstream PBS/lens/fiber receive nothing too).
      if (gateOverrides?.get(obj.id) === false) {
        continue;
      }
      const nominalLaserMw = Number(
        ((element.kindParams ?? {}) as { nominalPowerMw?: number }).nominalPowerMw,
      );
      segments.push(
        ...traceOneRay(
          originThree,
          dirThree,
          0,
          "main",
          ctx,
          obj.id,
          wavelengthNm,
          maxLengthMm,
          maxBounces,
          averageSpatialMode(element),
          0,
          obj.componentId,
          1.0,
          laserJones(element),
          Number.isFinite(nominalLaserMw) ? nominalLaserMw : 1.0,
          "main",
          obj.id,
        ),
      );
      continue;
    }

    // Tapered amplifier — the +X aperture is the INPUT/seed port for this
    // TA model. We first look for an already-traced incoming beam (PBSref in
    // the current setup) that is anti-parallel to the INPUT axis and lands
    // within the acceptance radius. The coupled seed power is:
    //   raw PBSref power × spatial mode overlap × polarization overlap.
    // The amplified output exits the opposite (-X) aperture.
    //
    // Power off: the TA chip is unpowered, so neither the amplified output
    // nor backward ASE leaves the device. Any seed beam arriving from
    // upstream still hit the front face (those segments were already
    // pushed by the laser-source loop) — they simply terminate there
    // since we skip the output emission entirely.
    if (poweredOffObjectIds?.has(obj.id)) {
      continue;
    }
    const taParams = (element.kindParams ?? {}) as {
      driveCurrentMa?: number;
      smallSignalGainDb?: number;
      saturationPowerMw?: number;
      inputAcceptanceRadiusMm?: number;
      ase?: { powerMw?: number; bandwidthNm?: number; centerOffsetNm?: number };
      aseSamples?: Array<{ driveCurrentMa: number; forwardPowerMw: number; backwardPowerMw: number }>;
      gainSamples?: Array<{
        inputPowerMw: number;
        driveCurrentMa: number;
        forwardPowerMw: number;
        backwardPowerMw: number;
      }>;
      backwardSpatialModeX?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
      backwardSpatialModeY?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
    };
    const driveCurrent = typeof taParams.driveCurrentMa === "number" ? taParams.driveCurrentMa : 2400;
    const inputMode = taInputSpatialMode(element);
    const inputPol = taInputJones(element);
    // Output beam takes its own polarization (chip-locked TM in most TAs);
    // backward ASE shares the seed-side facet so it stays on inputPol.
    const outputPol = taOutputJones(element);
    const acceptanceRadiusMm = typeof taParams.inputAcceptanceRadiusMm === "number" && taParams.inputAcceptanceRadiusMm > 0
      ? taParams.inputAcceptanceRadiusMm
      : 25;
    const seedCoupling = bestTaSeedCoupling(
      segments,
      obj.id,
      originThree,
      dirThree,
      inputMode,
      inputPol,
      acceptanceRadiusMm,
    );
    const asePower = interpolateAse(taParams.aseSamples ?? [], driveCurrent);
    const gainPower = seedCoupling && seedCoupling.effectiveSeedPowerMw > 1e-9
      ? interpolateTaGain(taParams.gainSamples ?? [], seedCoupling.effectiveSeedPowerMw, driveCurrent)
      : null;
    const outputMw = gainPower?.forwardMw
      ?? (seedCoupling ? saturatedTaPower(taParams, seedCoupling.effectiveSeedPowerMw) : asePower.forwardMw);
    const inputLeakMw = gainPower?.backwardMw ?? asePower.backwardMw;

    const forwardMode = averageSpatialMode(element);
    const backwardMode = backwardSpatialMode(element) ?? forwardMode;

    // Output emission — out of the -X face, continuing the seed direction.
    const outputDirThree = dirThree.clone().negate();
    // Phase 6: prefer the new frame-suffixed key, fall back to legacy.
    // asset.anchors.intercept_out (phy-edit-driven) wins over the legacy
    // properties field for the same reason as the input face above.
    const apertureBackProps = component?.properties as
      | { apertureBackwardMmBodyLocal?: number[]; apertureBackwardLocalMm?: number[] }
      | undefined;
    const outAnchorPos = asset?.anchors?.find((a) => a.id === "intercept_out")?.positionMmBodyLocal;
    // Same anchor-path / meshAperturePoint split as intercept_in above —
    // anchor is wrapper-local (alignment formula), legacy field is GLB-frame.
    const apertureBackwardLegacy = apertureBackProps?.apertureBackwardMmBodyLocal
      ?? apertureBackProps?.apertureBackwardLocalMm;
    const apertureBackwardOrigin: THREE.Vector3 | null = outAnchorPos
      ? (() => {
          const rotated = bodyLocalDirToLabDir(outAnchorPos, obj);
          return labToThreeVector([
            obj.xMm + rotated.x,
            obj.yMm + rotated.y,
            obj.zMm + rotated.z,
          ]);
        })()
      : (apertureBackwardLegacy && apertureBackwardLegacy.length === 3
        ? meshAperturePoint(componentGroup, obj.componentId, [
            apertureBackwardLegacy[0],
            apertureBackwardLegacy[1],
            apertureBackwardLegacy[2],
          ])
        : null);
    const outputMeshOrigin = meshFrontFaceCenter(
      componentGroup,
      obj.componentId,
      outputDirThree,
    );
    const outputOriginThree =
      apertureBackwardOrigin ?? outputMeshOrigin ?? labToThreeVector([labOrigin.x, labOrigin.y, labOrigin.z]);
    // Per-instance visualisation overrides for forward / backward emissions
    // (TA backward = the "input beam" the user can hide on the object panel).
    // Skipping at trace time also stops downstream optics from reflecting a
    // hidden beam — important for the user's mental model in the scene.
    const forwardVisual = getEmissionVisual(obj, "forward");
    const backwardVisual = getEmissionVisual(obj, "backward");
    // Phase PB.3 — TA forward + backward both gated by the same scrub
    // override (a TA's TimingProgram drives the whole device, not a
    // single port). When `false`, both arms are suppressed.
    const taGated = gateOverrides?.get(obj.id) === false;
    if (forwardVisual.visible && !taGated) {
      segments.push(
        ...traceOneRay(
          outputOriginThree,
          outputDirThree,
          0,
          "main",
          ctx,
          obj.id,
          seedCoupling?.seedSourceObjectId ? (segments.find((s) => s.sourceObjectId === seedCoupling.seedSourceObjectId)?.wavelengthNm ?? wavelengthNm) : wavelengthNm,
          maxLengthMm,
          maxBounces,
          forwardMode,
          0,
          obj.componentId,
          1.0,
          outputPol,
          outputMw,
          "forward",
          obj.id,
          seedCoupling ?? undefined,
        ),
      );
    }

    // Input-port leakage / backward ASE — out of the +X INPUT face.
    if (backwardVisual.visible && !taGated) {
      segments.push(
        ...traceOneRay(
          originThree,
          dirThree,
          0,
          "main",
          ctx,
          obj.id,
          wavelengthNm,
          maxLengthMm,
          maxBounces,
          backwardMode,
          0,
          obj.componentId,
          1.0,
          inputPol,
          inputLeakMw,
          "backward",
          obj.id,
          seedCoupling ?? undefined,
        ),
      );
    }
  }

  // Restore visibility on the meshes we temporarily flipped on at the
  // start. Doing this AFTER all traces complete (not after each emitter)
  // means a hidden mirror keeps reflecting beams from every emitter in
  // this single pass, not just the first.
  for (const node of reHidden) {
    node.visible = false;
  }

  return segments;
}

/** 1-D linear interpolation of (drive_current → forward / backward) ASE
 *  power samples. Clamped at the endpoints. Empty list returns 0/0. */
function interpolateAse(
  samples: Array<{ driveCurrentMa: number; forwardPowerMw: number; backwardPowerMw: number }>,
  driveCurrentMa: number,
): { forwardMw: number; backwardMw: number } {
  if (!samples.length) return { forwardMw: 0, backwardMw: 0 };
  const sorted = [...samples].sort((a, b) => a.driveCurrentMa - b.driveCurrentMa);
  if (driveCurrentMa <= sorted[0].driveCurrentMa) {
    return { forwardMw: sorted[0].forwardPowerMw, backwardMw: sorted[0].backwardPowerMw };
  }
  const last = sorted[sorted.length - 1];
  if (driveCurrentMa >= last.driveCurrentMa) {
    return { forwardMw: last.forwardPowerMw, backwardMw: last.backwardPowerMw };
  }
  for (let i = 1; i < sorted.length; i++) {
    if (driveCurrentMa <= sorted[i].driveCurrentMa) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const t = (driveCurrentMa - a.driveCurrentMa) / (b.driveCurrentMa - a.driveCurrentMa);
      return {
        forwardMw: a.forwardPowerMw + (b.forwardPowerMw - a.forwardPowerMw) * t,
        backwardMw: a.backwardPowerMw + (b.backwardPowerMw - a.backwardPowerMw) * t,
      };
    }
  }
  return { forwardMw: 0, backwardMw: 0 };
}

/** Backward spatial mode for a TA. Returns null when the kindParams don't
 *  include backward_spatial_mode_x/y — caller falls back to the forward
 *  mode so the backward beam still has a sensible width. */
function backwardSpatialMode(element: PhysicsElement): BeamState | null {
  const params = (element.kindParams ?? {}) as {
    centerWavelengthNm?: number;
    backwardSpatialModeX?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
    backwardSpatialModeY?: { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
  };
  const x = params.backwardSpatialModeX;
  const y = params.backwardSpatialModeY;
  if (!x && !y) return null;
  const wxUm = x?.waistUm ?? y?.waistUm ?? 100;
  const wyUm = y?.waistUm ?? x?.waistUm ?? 100;
  const mxSq = x?.mSquared ?? 1;
  const mySq = y?.mSquared ?? 1;
  const wxZ = x?.waistZOffsetMm ?? 0;
  const wyZ = y?.waistZOffsetMm ?? 0;
  return {
    waist0Um: 0.5 * (wxUm + wyUm),
    waistZUm: 1000 * 0.5 * (wxZ + wyZ),
    mSquared: 0.5 * (mxSq + mySq),
    wavelengthNm: typeof params.centerWavelengthNm === "number" ? params.centerWavelengthNm : 780,
  };
}
