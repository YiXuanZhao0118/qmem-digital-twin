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

import {
  dirBodyToLab,
  dirLabToBody,
  pointBodyToLab,
  pointLabToBody,
  type V3Pose,
} from "../optical/pose";
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


// ── Receptacle predicates ────────────────────────────────────────────────

/** True when an anchor's `connectorType` names a fibre bulkhead, i.e. the
 *  anchor is a receptacle a patch cable can be plugged into rather than a
 *  free-space optical face. Deliberately prefix-based like
 *  `connectorFamilyFromAnchor` in `rfLinkPorts.ts`, so adding `sc_*` /
 *  `lc_*` to the union needs no change here.
 *
 *  **Female only** (2026-08-23). A receptacle is a socket on a chassis; the
 *  ferrule on the end of a patch cable or a pigtail is a PLUG and carries
 *  `*_male`. This matters because `sceneStore.collectFiberPortsLab` filters
 *  on this predicate alone and never looks at the anchor id — once cable ends
 *  declare their connector, a gender-blind test would list every one of them
 *  as a socket and let two patch cables be plugged into each other.
 *
 *  The backend twin is `app/optical/fibers/scene.py`'s port sweep, which is
 *  what actually decides a candidate list since 2026-09-23; this copy now
 *  only feeds the Object panel's own port list and Align gating. */
export function isFiberPortConnectorType(
  connectorType: string | null | undefined,
): boolean {
  if (typeof connectorType !== "string") return false;
  return /^(fc|sc|lc|st)_.*_female$/.test(connectorType);
}

/** Every optical anchor id that can carry light in or out of a part — the
 *  set {@link isFiberReceptacleAnchor} is asked about. */
export const OPTICAL_PORT_ANCHOR_IDS = [
  "intercept_in", "intercept_out", "fiber_in",
] as const;

/** True when an anchor is somewhere a patch cable PLUGS IN rather than a
 *  free-space face a beam can be flown onto.
 *
 *  Two ways to be one, and both are needed:
 *    - `fiber_in` — a chassis socket by construction; that is what the id
 *      means, so no connectorType test applies. It is the ONLY socket id:
 *      `fiber_out` is a CONNECTOR's mating face (male) and `fiber_root` its
 *      cable junction, neither of which anything plugs into.
 *    - an `intercept_*` declaring a female fibre connector — the pre-0133
 *      spelling, still the right answer for any part that has not moved.
 *
 *  Used by the Object panel to decide a part has nothing to align: light
 *  reaches it down a cable, so translating the box onto a beam line is
 *  meaningless. A part with BOTH a bulkhead and a bare face keeps Align for
 *  the bare one, which is why this is per-anchor and the caller does the
 *  `every`. */
export function isFiberReceptacleAnchor(anchor: {
  id: string;
  connectorType?: string | null;
}): boolean {
  return anchor.id === "fiber_in" || isFiberPortConnectorType(anchor.connectorType);
}


// ── The per-end port pose (the Object panel's editor) ─────────────────────

type Vec3T = [number, number, number];

/** Current outward direction at a spline endpoint, in BODY frame: −handle
 *  when present, else the direction toward the neighbour node, else +Y as a
 *  last resort. The sign convention every fibre endpoint write uses — the
 *  handle points INTO the cable, outward points out of the ferrule.
 *
 *  The backend twin is `optical/fibers/geometry.endpoint_outward_body`. */
export function endpointOutwardBody(
  nodes: FiberNodePersistent[],
  end: "A" | "B",
): Vec3T {
  const idx = end === "A" ? 0 : nodes.length - 1;
  const neighbourIdx = end === "A" ? 1 : nodes.length - 2;
  const node = nodes[idx];
  const handle = end === "A" ? node.handleOutMm : node.handleInMm;
  if (handle && handle[0] ** 2 + handle[1] ** 2 + handle[2] ** 2 > 1e-9) {
    const m = Math.hypot(handle[0], handle[1], handle[2]);
    return [-handle[0] / m, -handle[1] / m, -handle[2] / m];
  }
  const np = nodes[neighbourIdx].posMm;
  const dx = node.posMm[0] - np[0];
  const dy = node.posMm[1] - np[1];
  const dz = node.posMm[2] - np[2];
  const m = Math.hypot(dx, dy, dz);
  return m > 1e-9 ? [dx / m, dy / m, dz / m] : [0, 1, 0];
}

/** Read one fibre end's optical-port pose in LAB frame: the face position
 *  (= node + outward·`tipMm`, body→lab) and the outward unit vector in lab.
 *  Returns null when the spline is too short or undefined.
 *
 *  Used by the Object panel's per-end port-pose editor, so the user sees
 *  WHERE the port sits in world coords and which way it faces without doing
 *  the body↔lab transform in their head. {@link withFiberPortLabPose} is the
 *  write half and MUST be given the same `tipMm`.
 *
 *  `tipMm` is the junction→optical-face distance of THIS end's bound
 *  connector (`sceneStore.fiberEndConnectorTipMm`) — the length the backend's
 *  `_synth_fiber_slot` puts the traced face at. It defaults to the FC housing
 *  constant, which is right only for a fibre with no bound connector; before
 *  2026-09-23 the editor used that constant unconditionally and so showed and
 *  wrote a face ~23 mm (PM connectors) off the one the solver couples
 *  through. */
export function getFiberPortLabPose(
  end: "A" | "B",
  nodes: FiberNodePersistent[],
  pose: V3Pose,
  tipMm: number = FIBER_FERRULE_TIP_MM,
): { posLab: Vec3T; outwardLab: Vec3T } | null {
  if (!nodes || nodes.length < 2) return null;
  const idx = end === "A" ? 0 : nodes.length - 1;
  const outwardBody = endpointOutwardBody(nodes, end);
  const node = nodes[idx];
  const portLab = pointBodyToLab(
    {
      x: node.posMm[0] + outwardBody[0] * tipMm,
      y: node.posMm[1] + outwardBody[1] * tipMm,
      z: node.posMm[2] + outwardBody[2] * tipMm,
    },
    pose,
  );
  const outLab = dirBodyToLab(
    { x: outwardBody[0], y: outwardBody[1], z: outwardBody[2] }, pose,
  );
  return {
    posLab: [portLab.x, portLab.y, portLab.z],
    outwardLab: [outLab.x, outLab.y, outLab.z],
  };
}

/** Write a target optical-port pose in LAB frame for one fibre end. Returns a
 *  fresh `nodes` array with the touched endpoint's node + handle back-derived:
 *
 *    outward_body = labDirToBody(targetOutwardLab)
 *    node_body    = labToBody(targetPosLab) − outward_body · tipMm
 *    handle_body  = −outward_body · |prev_handle|   (or fallback length)
 *
 *  The handle MAGNITUDE is preserved from the previous handle when present
 *  (so the existing tension/bend stays intact), or falls back to
 *  max(20 mm, segment_length·0.33). Interior nodes don't move.
 *
 *  This is the ONE fibre-endpoint write with no backend endpoint behind it:
 *  it sets an arbitrary pose the user typed, not a projection onto a beam or
 *  a mate into a receptacle, so there is nothing for
 *  `POST /api/v3/fibers/{id}/apply` to recompute. It shares `tipMm` with
 *  everything that does — see {@link getFiberPortLabPose}.
 *
 *  `targetOutwardLab` is normalised before use; below 1e-9 magnitude the
 *  function returns `nodes` unchanged. */
export function withFiberPortLabPose(opts: {
  end: "A" | "B";
  nodes: FiberNodePersistent[];
  pose: V3Pose;
  targetPosLab: Vec3T;
  targetOutwardLab: Vec3T;
  tipMm?: number;
}): FiberNodePersistent[] {
  const { end, nodes, pose, targetPosLab, targetOutwardLab } = opts;
  if (!nodes || nodes.length < 2) return nodes;
  const tipMm = opts.tipMm ?? FIBER_FERRULE_TIP_MM;
  const outwardMag = Math.hypot(
    targetOutwardLab[0], targetOutwardLab[1], targetOutwardLab[2],
  );
  if (outwardMag < 1e-9) return nodes;
  const idx = end === "A" ? 0 : nodes.length - 1;
  const neighbourIdx = end === "A" ? 1 : nodes.length - 2;
  const outB = dirLabToBody(
    {
      x: targetOutwardLab[0] / outwardMag,
      y: targetOutwardLab[1] / outwardMag,
      z: targetOutwardLab[2] / outwardMag,
    },
    pose,
  );
  const outwardBody: Vec3T = [outB.x, outB.y, outB.z];
  const portBody = pointLabToBody(
    { x: targetPosLab[0], y: targetPosLab[1], z: targetPosLab[2] }, pose,
  );
  const newPosBody: Vec3T = [
    portBody.x - outwardBody[0] * tipMm,
    portBody.y - outwardBody[1] * tipMm,
    portBody.z - outwardBody[2] * tipMm,
  ];

  // Preserve handle magnitude when the existing handle is non-zero.
  const oldHandle = end === "A" ? nodes[idx].handleOutMm : nodes[idx].handleInMm;
  let handleLen: number;
  if (
    oldHandle
    && oldHandle[0] ** 2 + oldHandle[1] ** 2 + oldHandle[2] ** 2 > 1e-9
  ) {
    handleLen = Math.hypot(oldHandle[0], oldHandle[1], oldHandle[2]);
  } else {
    const np = nodes[neighbourIdx].posMm;
    const segLen = Math.hypot(
      np[0] - nodes[idx].posMm[0],
      np[1] - nodes[idx].posMm[1],
      np[2] - nodes[idx].posMm[2],
    );
    handleLen = Math.max(20, segLen * 0.33);
  }
  // Handle points INTO the spline; outward = −handle ⇒ handle = −outward.
  const newHandle: Vec3T = [
    -outwardBody[0] * handleLen,
    -outwardBody[1] * handleLen,
    -outwardBody[2] * handleLen,
  ];

  const newNode: FiberNodePersistent = {
    posMm: newPosBody,
    handleInMm:
      end === "B"
        ? newHandle
        : nodes[idx].handleInMm
          ? ([...nodes[idx].handleInMm] as Vec3T)
          : undefined,
    handleOutMm:
      end === "A"
        ? newHandle
        : nodes[idx].handleOutMm
          ? ([...nodes[idx].handleOutMm] as Vec3T)
          : undefined,
  };
  const nextNodes = [...nodes];
  nextNodes[idx] = newNode;
  return nextNodes;
}
