// Fiber port anchor resolver.
//
// Fiber port anchors (intercept_in / intercept_out) can opt into being
// "derived" from the live fiber via the `Anchor.derivedFromFiberEndpoint`
// field. The single source of truth is the fiber PE's
// `kindParams.endA / endB` sub-object (alembic 0056 + 2026-05-17 contract):
//   * `posMm`            = ferrule TIP = optical port body-local position
//   * `tensionHandleMm`  = wire-extension body-local direction
//
// All consumers that read anchor positions for fiber ports should funnel
// through `resolveAnchorPosition` / `resolveAnchorDirection` so the
// renderer, ray-tracer, and solver agree on where the port physically is.
//
// When kindParams isn't available (un-instantiated catalog template, or
// missing PE), the helper falls back to the anchor's stored
// `positionMmBodyLocal` / `directionBodyLocal` — same behaviour as
// before kindParams existed.

import type { Anchor } from "../types/digitalTwin";

export type FiberNodePersistent = {
  posMm: [number, number, number];
  handleInMm?: [number, number, number];
  handleOutMm?: [number, number, number];
};

/** Length in mm from the cable-side end of the FC connector (= the
 *  Bezier spline endpoint) to the ferrule tip (= the optical port face).
 *  Matches the cached 30126A9 STL housing length in
 *  `loadAsset.FC_HOUSING_LENGTH_MM`. Anywhere we map between spline
 *  endpoint and optical port lives off this single constant. */
export const FIBER_FERRULE_TIP_MM = 36.28;

/** kindParams.endA / endB sub-object, body-local frame.
 *    `posMm`           = ferrule TIP = optical port position
 *    `tensionHandleMm` = wire-extension direction (= spline tangent at
 *                        the spline endpoint, which sits 36.28 mm in
 *                        the +tension direction from the tip)
 *    `rotDeg`          = residual ferrule roll metadata (visual only;
 *                        does NOT rotate the wire tangent) */
export type FiberEndKindParamsShape = {
  posMm?: number[] | null;
  tensionHandleMm?: number[] | null;
  rotDeg?: number[] | null;
};

/** Effective body-local position of an anchor. For derived fiber ports
 *  this reads `kindParams.endA/endB.posMm` directly (= the ferrule tip
 *  = the optical port). Falls back to the anchor's stored
 *  `positionMmBodyLocal` when kindParams isn't available. */
export function resolveAnchorPosition(
  anchor: Anchor,
  kindParamsEndA: FiberEndKindParamsShape | null | undefined,
  kindParamsEndB: FiberEndKindParamsShape | null | undefined,
): { x: number; y: number; z: number } {
  const end = anchor.derivedFromFiberEndpoint;
  if (!end) return anchor.positionMmBodyLocal;
  const params = end === "A" ? kindParamsEndA : kindParamsEndB;
  const pos = params?.posMm;
  if (!Array.isArray(pos) || pos.length !== 3) return anchor.positionMmBodyLocal;
  // posMm is the JUNCTION (back of connector). Optical tip = junction
  // + outward · FIBER_FERRULE_TIP_MM where outward = -unit(tension).
  const tau = params?.tensionHandleMm;
  if (!Array.isArray(tau) || tau.length !== 3) {
    return { x: pos[0] as number, y: pos[1] as number, z: pos[2] as number };
  }
  const mag = Math.hypot(tau[0] as number, tau[1] as number, tau[2] as number);
  if (mag < 1e-9) {
    return { x: pos[0] as number, y: pos[1] as number, z: pos[2] as number };
  }
  return {
    x: (pos[0] as number) - ((tau[0] as number) / mag) * FIBER_FERRULE_TIP_MM,
    y: (pos[1] as number) - ((tau[1] as number) / mag) * FIBER_FERRULE_TIP_MM,
    z: (pos[2] as number) - ((tau[2] as number) / mag) * FIBER_FERRULE_TIP_MM,
  };
}

/** Effective body-local direction of an anchor. For derived fiber ports
 *  this is the OUTWARD direction = -unit(tensionHandleMm) (the way the
 *  ferrule tip faces, i.e. into free space away from the wire). Falls
 *  back to `directionBodyLocal` (or +Y when that's missing). */
export function resolveAnchorDirection(
  anchor: Anchor,
  kindParamsEndA: FiberEndKindParamsShape | null | undefined,
  kindParamsEndB: FiberEndKindParamsShape | null | undefined,
): { x: number; y: number; z: number } {
  const end = anchor.derivedFromFiberEndpoint;
  if (!end) return anchor.directionBodyLocal ?? { x: 0, y: 1, z: 0 };
  const params = end === "A" ? kindParamsEndA : kindParamsEndB;
  const tau = params?.tensionHandleMm;
  if (!Array.isArray(tau) || tau.length !== 3) {
    return anchor.directionBodyLocal ?? { x: 0, y: 1, z: 0 };
  }
  const mag = Math.hypot(tau[0] as number, tau[1] as number, tau[2] as number);
  if (mag < 1e-9) return anchor.directionBodyLocal ?? { x: 0, y: 1, z: 0 };
  return {
    x: -(tau[0] as number) / mag,
    y: -(tau[1] as number) / mag,
    z: -(tau[2] as number) / mag,
  };
}

/** Convenience: pulls kindParams.endA / endB from a fiber PE.
 *  Pass the result to `resolveAnchorPosition` / `resolveAnchorDirection`. */
export function resolveFiberEndKindParams(
  fiberPhysicsElement: { kindParams?: unknown } | null | undefined,
): { endA: FiberEndKindParamsShape | null; endB: FiberEndKindParamsShape | null } {
  const kp = (fiberPhysicsElement?.kindParams ?? null) as
    | { endA?: FiberEndKindParamsShape | null; endB?: FiberEndKindParamsShape | null }
    | null;
  return {
    endA: kp?.endA ?? null,
    endB: kp?.endB ?? null,
  };
}

/** Sync fiber.properties.fiberNodes endpoints from kindParams.endA / endB.
 *  After this, downstream readers that still rely on fiberNodes (ray
 *  tracer, panel's getFiberPortLabPose, etc.) see the same position the
 *  renderer uses.
 *
 *  Mapping (2026-05-17 clarified contract — posMm = back of connector):
 *    fiberNodes[0].posMm        = endA.posMm           (identity)
 *    fiberNodes[0].handleOutMm  = endA.tensionHandleMm (body-local tangent)
 *    fiberNodes[N-1].posMm      = endB.posMm           (identity)
 *    fiberNodes[N-1].handleInMm = endB.tensionHandleMm
 *  Interior nodes [1..N-2] pass through. Ray tracer + panel compute
 *  optical tip = posMm + outward · FIBER_FERRULE_TIP_MM separately. */
export function syncFiberNodesFromKindParams(
  endA: FiberEndKindParamsShape | null | undefined,
  endB: FiberEndKindParamsShape | null | undefined,
  existingNodes: FiberNodePersistent[] | null | undefined,
): FiberNodePersistent[] {
  const interior = (existingNodes && existingNodes.length > 2)
    ? existingNodes.slice(1, -1).map((n) => ({
        posMm: [n.posMm[0], n.posMm[1], n.posMm[2]] as [number, number, number],
        handleInMm: n.handleInMm ? [...n.handleInMm] as [number, number, number] : undefined,
        handleOutMm: n.handleOutMm ? [...n.handleOutMm] as [number, number, number] : undefined,
      }))
    : [];

  const endpointNode = (
    params: FiberEndKindParamsShape | null | undefined,
    handleKey: "handleOutMm" | "handleInMm",
    fallbackPos: [number, number, number],
    fallbackTau: [number, number, number],
  ): FiberNodePersistent => {
    const pos = (Array.isArray(params?.posMm) && params!.posMm!.length === 3)
      ? [params!.posMm![0] as number, params!.posMm![1] as number, params!.posMm![2] as number] as [number, number, number]
      : [...fallbackPos] as [number, number, number];
    const tau = (Array.isArray(params?.tensionHandleMm) && params!.tensionHandleMm!.length === 3)
      ? [
          params!.tensionHandleMm![0] as number,
          params!.tensionHandleMm![1] as number,
          params!.tensionHandleMm![2] as number,
        ] as [number, number, number]
      : [...fallbackTau] as [number, number, number];
    const node: FiberNodePersistent = {
      posMm: pos,
      [handleKey]: tau,
    } as FiberNodePersistent;
    return node;
  };

  const first = endpointNode(endA, "handleOutMm", [0, 0, 0], [10, 0, 0]);
  const last = endpointNode(endB, "handleInMm", [300, 0, 0], [-10, 0, 0]);
  return [first, ...interior, last];
}

/** Legacy: pulls the resolved fiberNodes off a SceneObject's properties.
 *  Kept so any callers still passing fiberNodes around don't break — but
 *  fiber anchor lookups should switch to `resolveFiberEndKindParams`. */
export function resolveFiberNodes(
  objectProperties: unknown,
  componentProperties: unknown,
): FiberNodePersistent[] | undefined {
  const objNodes = (objectProperties as { fiberNodes?: FiberNodePersistent[] } | null | undefined)
    ?.fiberNodes;
  if (Array.isArray(objNodes) && objNodes.length >= 2) return objNodes;
  const compNodes = (componentProperties as { fiberNodes?: FiberNodePersistent[] } | null | undefined)
    ?.fiberNodes;
  if (Array.isArray(compNodes) && compNodes.length >= 2) return compNodes;
  return undefined;
}
