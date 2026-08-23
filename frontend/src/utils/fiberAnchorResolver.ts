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
import { findCableRootAnchor, findMatingFaceAnchor } from "./connectorAnchors";

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

/** Standoff (mm) between a plugged-in fibre's optical face and the port
 *  plane it mates against.
 *
 *  It is not cosmetic: `anchor_tracer.nearest_anchor_hit` rejects any
 *  intersection with `t < t_min` (1e-9), so a ray emitted EXACTLY on the
 *  receiving plane never registers a hit — mate the two faces perfectly and
 *  the light sails straight through the instrument. The gap gives the ray a
 *  positive path length to the plane.
 *
 *  10 µm is chosen to be enormous next to `t_min` and float round-trip noise
 *  (~1e-12 mm through the body↔lab transforms) while staying optically
 *  negligible: a 62.5 µm OM1 core at NA 0.275 widens by ~5 µm over it, which
 *  is nothing against the receptacle apertures this mates into, and the
 *  Marcuse overlap a fibre-to-fibre joint would pay is unmeasurable. */
export const FIBER_MATING_GAP_MM = 0.01;

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

// ── Endpoint links (a fibre end plugged into an instrument's port) ────────

type Vec3T = [number, number, number];

type LinkPose = {
  xMm: number; yMm: number; zMm: number;
  rxDeg: number; ryDeg: number; rzDeg: number;
};

/** body↔lab for one SceneObject pose. Same convention as everywhere else
 *  in the store: lab = pose + R_z · R_x · R_y · body. Kept local (rather
 *  than importing `optical/pose`) so this module stays dependency-light,
 *  matching `rfCableAnchorResolver`'s own copy. */
function makeLinkTransforms(pose: LinkPose) {
  const rxr = (pose.rxDeg * Math.PI) / 180;
  const ryr = (pose.ryDeg * Math.PI) / 180;
  const rzr = (pose.rzDeg * Math.PI) / 180;
  const cx = Math.cos(rxr), sxr = Math.sin(rxr);
  const cy = Math.cos(ryr), syr = Math.sin(ryr);
  const cz = Math.cos(rzr), szr = Math.sin(rzr);
  const rot = (v: Vec3T): Vec3T => {
    const x1 = cy * v[0] + syr * v[2];
    const y1 = v[1];
    const z1 = -syr * v[0] + cy * v[2];
    const y2 = cx * y1 - sxr * z1;
    const z2 = sxr * y1 + cx * z1;
    return [cz * x1 - szr * y2, szr * x1 + cz * y2, z2];
  };
  const invRot = (v: Vec3T): Vec3T => {
    const x2 = cz * v[0] + szr * v[1];
    const y2 = -szr * v[0] + cz * v[1];
    const z2 = v[2];
    const y1 = cx * y2 + sxr * z2;
    const z1 = -sxr * y2 + cx * z2;
    return [cy * x2 - syr * z1, y1, syr * x2 + cy * z1];
  };
  return {
    bodyToLab: (v: Vec3T): Vec3T => {
      const r = rot(v);
      return [pose.xMm + r[0], pose.yMm + r[1], pose.zMm + r[2]];
    },
    bodyToLabDir: rot,
    labToBody: (v: Vec3T): Vec3T =>
      invRot([v[0] - pose.xMm, v[1] - pose.yMm, v[2] - pose.zMm]),
    labToBodyDir: invRot,
  };
}

/** Re-derive one fibre end's spline node + handle from the LIVE pose of the
 *  port it is linked to — the optical twin of `resolveLinkedRfCableEndpoint`.
 *
 *  This is what makes a plugged-in patch cable follow its instrument: the
 *  stored node is only a fallback, and the viewer calls this every draw so
 *  dragging the receiver carries the fibre end along without a re-align.
 *
 *  The mating invariant is "coincident faces, opposite directions": the
 *  fibre's optical face lands ON the port and its outward is anti-parallel
 *  to the port's outward. `tipMm` is the junction→face distance for THIS
 *  end's connector — pass the bound connector asset's
 *  `|connect_in − connect_out|` so the face lands exactly where the backend
 *  puts the synthesized `intercept_in/out`.
 *
 *  Returns null when the link can't be resolved (degenerate port direction);
 *  the caller then keeps the stored nodes so the fibre still renders. */
export function resolveLinkedFiberEndpoint(args: {
  endpoint: "A" | "B";
  /** The fibre SceneObject's live pose. */
  fiberPose: LinkPose;
  /** The linked instrument's live pose. */
  targetPose: LinkPose;
  /** Port anchor's body-local position on the target asset (mm). */
  targetAnchorPosBodyMm: Vec3T;
  /** Port anchor's body-local outward direction (the receptacle's face
   *  normal). Need not be normalised. */
  targetAnchorDirBody: Vec3T;
  /** Junction → optical-face distance of this fibre end's connector.
   *  Defaults to the FC 30126A9 housing length. */
  tipMm?: number;
  /** Handle magnitude to set on the linked endpoint. Defaults to 30 mm,
   *  matching the RF resolver. */
  handleMagnitudeMm?: number;
}): { posMmBody: Vec3T; handleMmBody: Vec3T } | null {
  const tipMm = args.tipMm ?? FIBER_FERRULE_TIP_MM;
  const targetT = makeLinkTransforms(args.targetPose);
  const fiberT = makeLinkTransforms(args.fiberPose);

  const portLab = targetT.bodyToLab(args.targetAnchorPosBodyMm);
  const axLab = targetT.bodyToLabDir(args.targetAnchorDirBody);
  const m = Math.hypot(axLab[0], axLab[1], axLab[2]);
  if (m < 1e-9) return null;
  // NOT the RF anti-parallel rule. An RF port's direction is a mechanical
  // outward face normal, so a plug always faces into it. An OPTICAL anchor's
  // axisX is the PROPAGATION direction (see anchors.md), so the face
  // orientation follows the same rule the beam-align path uses:
  //   End A is an entry — its face looks back up the beam  → outward = −axisX
  //   End B is an exit  — its face looks along the beam    → outward = +axisX
  // Plugging End B into a detector's `intercept_in` (axisX = into the body)
  // therefore points the fibre the same way the light travels; plugging End A
  // into a source's `intercept_out` points it back at the source. The wrong
  // pairing (End A into a sink) comes out facing away, which is the visual
  // tell that the cable is round the wrong way.
  const sign = args.endpoint === "A" ? -1 : 1;
  const newOutwardLab: Vec3T = [
    (sign * axLab[0]) / m, (sign * axLab[1]) / m, (sign * axLab[2]) / m,
  ];
  // node = face − outward · tip, and face = port − outward · gap, so the
  // optical face sits FIBER_MATING_GAP_MM short of the plane (see the
  // constant for why it may not be zero).
  const backOff = tipMm + FIBER_MATING_GAP_MM;
  const newNodeLab: Vec3T = [
    portLab[0] - newOutwardLab[0] * backOff,
    portLab[1] - newOutwardLab[1] * backOff,
    portLab[2] - newOutwardLab[2] * backOff,
  ];
  const posMmBody = fiberT.labToBody(newNodeLab);
  const newOutwardBody = fiberT.labToBodyDir(newOutwardLab);
  const mag = args.handleMagnitudeMm ?? 30;
  return {
    posMmBody,
    // Handle points into the cable body — the sign `endpointOutwardBody`
    // expects when it reads the outward back out.
    handleMmBody: [
      -newOutwardBody[0] * mag,
      -newOutwardBody[1] * mag,
      -newOutwardBody[2] * mag,
    ],
  };
}

/** Junction → optical-face distance read off a bound fibre connector asset's
 *  own anchors: `|connect_in − connect_out|`. This is the SAME derivation the
 *  backend uses in `_connector_tip_and_aperture`, so frontend geometry and
 *  the synthesized optical slot agree on where the face is. Falls back to the
 *  FC housing constant when the asset or either anchor is missing.
 *
 *  Mirrors `connectorTipMmFromAnchors` in `rfCableAnchorResolver.ts`. */
export function fiberConnectorTipMmFromAnchors(
  anchors: ReadonlyArray<Pick<Anchor, "id" | "positionMmBodyLocal">> | null | undefined,
): number {
  if (!anchors) return FIBER_FERRULE_TIP_MM;
  const cIn = findMatingFaceAnchor(anchors);
  const cOut = findCableRootAnchor(anchors);
  if (!cIn || !cOut) return FIBER_FERRULE_TIP_MM;
  const d = Math.hypot(
    cIn.positionMmBodyLocal.x - cOut.positionMmBodyLocal.x,
    cIn.positionMmBodyLocal.y - cOut.positionMmBodyLocal.y,
    cIn.positionMmBodyLocal.z - cOut.positionMmBodyLocal.z,
  );
  return d > 1e-6 ? d : FIBER_FERRULE_TIP_MM;
}
