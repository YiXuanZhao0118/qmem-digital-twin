// Fiber body endpoint resolver.
//
// A fiber is represented by one SceneObject. End A / End B pose data
// lives inline on that fiber PhysicsElement's kindParams.endA / endB,
// already in the fiber BODY-local frame:
//
//   endA / endB: {
//     posMm: [x, y, z]              // emission point at the ferrule tip
//     rotDeg: [rx, ry, rz]          // residual ferrule roll/orientation metadata
//     tensionHandleMm: [dx, dy, dz] // wire extension direction from this end
//                                  // into the fiber body, BODY-local mm
//   }
//
// Important convention:
// - tensionHandleMm is the single source of truth for BOTH the Bezier tangent
//   at the fiber line endpoint and the ferrule head direction.
// - The visible connector model is anchored by its tip/port face. Its rear
//   wire-junction point is derived from the tip:
//     rear = tip + unit(tensionHandleMm) * FIBER_END_CONNECTOR_LENGTH_MM
// - rotDeg must not rotate the wire tangent. It is residual ferrule metadata
//   (for example visual roll / slow-axis presentation).

export type Vec3 = [number, number, number];

export type FiberEndKindParams = {
  posMm?: Vec3 | number[] | null;
  rotDeg?: Vec3 | number[] | null;
  tensionHandleMm?: Vec3 | number[] | null;
};

export type FiberEndpointResolved = {
  /** Spline endpoint / connector rear in fiber BODY local frame. Caller copies
   *  into `fiberNodes[0]` (end A) or `fiberNodes[N-1]` (end B). */
  posMmBody: Vec3;
  /** Bezier tangent handle in fiber BODY local frame. For end A this is
   *  written as handleOutMm; for end B this is written as handleInMm. */
  handleMmBody: Vec3;
};

/** Legacy alias preserved for the existing test suite; routes to the
 *  canonical FIBER_FERRULE_TIP_MM so updating the connector length in
 *  one place (fiberAnchorResolver.ts) propagates here too. */
export const FIBER_END_TIP_OFFSET_MM = FIBER_FERRULE_TIP_MM;
export const FIBER_END_CONNECTOR_LENGTH_MM = FIBER_FERRULE_TIP_MM;
export const FIBER_END_TENSION_DEFAULT_MM = 30.0;
const DEFAULT_TENSION: Vec3 = [0, FIBER_END_TENSION_DEFAULT_MM, 0];

function coerceVec3(value: Vec3 | number[] | null | undefined, fallback: Vec3): Vec3 {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  return fallback;
}

/** Compute the body-local spline endpoint position + Bezier handle from
 *  a fiber PE's kindParams.endA / endB sub-object.
 *
 *  Contract (2026-05-17, post-clarification):
 *    `posMm` is the BACK of the connector = where the fiber wire physically
 *    meets the connector ("junction") = the spline endpoint = the mesh
 *    origin. The optical TIP (= emission point = anchor) sits 36 mm
 *    along the outward direction (-unit(tension)) from posMm.
 *
 *  Returns:
 *    posMmBody = posMm (identity — the spline ends at the junction).
 *    handleMmBody = tensionHandleMm (body-local wire-extension direction;
 *                   rotDeg is ferrule-roll metadata only, never rotates
 *                   the wire tangent). */
export function resolveEndpointFromKindParams(
  end: "A" | "B",
  endParams: FiberEndKindParams | null | undefined,
): FiberEndpointResolved | null {
  if (!endParams) return null;
  const posMm = coerceVec3(endParams.posMm, [0, 0, 0]);
  const tension = coerceVec3(endParams.tensionHandleMm, DEFAULT_TENSION);
  const tensionMag = Math.hypot(tension[0], tension[1], tension[2]);
  if (tensionMag < 1e-9) return null;
  void end;
  return { posMmBody: [posMm[0], posMm[1], posMm[2]], handleMmBody: tension };
}

/** Inverse of resolveEndpointFromKindParams. A dragged endpoint handle is
 *  already a body-local tension vector, so this intentionally returns it
 *  unchanged. */
export function bodyHandleToTensionHandle(
  endParams: FiberEndKindParams | null | undefined,
  newBodyHandleMm: Vec3,
): Vec3 {
  void endParams;
  return newBodyHandleMm;
}
import { FIBER_FERRULE_TIP_MM } from "./fiberAnchorResolver";
