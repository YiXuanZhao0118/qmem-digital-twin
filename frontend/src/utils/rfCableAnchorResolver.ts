// RF cable port anchor resolver — parallels `fiberAnchorResolver.ts`.
//
// rf_in / rf_out anchors on rf_cable kinds can opt into being derived
// from the live cable spline endpoints via the
// `Anchor.derivedFromRfCableEndpoint` field. When set, the anchor's
// effective body-local position and direction are computed from the
// current `SceneObject.properties.rfCableNodes` (or a legacy catalog
// fallback) at read time, so dragging a cable endpoint in solid view
// automatically moves the port marker / connection target / cable-
// routing intercept without the user having to re-edit the anchor.
//
// When the spline is missing (un-instantiated catalog template, or
// `rfCableNodes` undefined / length < 2) the helper falls back to the
// anchor's stored `positionMmBodyLocal` / `directionBodyLocal`.
//
// Mirrors the fiber resolver almost exactly — the only physical
// difference is the connector tip offset: an SMA male connector adds
// ~15 mm of housing beyond the cable jacket end (boot + ferrule +
// coupling barrel + PTFE + pin in `createSmaShortCable`), vs the FC
// connector's 36.28 mm ferrule for fiber.

import type { Anchor } from "../types/digitalTwin";

export type RfCableNodePersistent = {
  posMm: [number, number, number];
  handleInMm?: [number, number, number];
  handleOutMm?: [number, number, number];
};

/** Length in mm from the cable-side end of the SMA-male connector (=
 *  the Bezier spline endpoint where the jacket terminates) to the
 *  connector mating face (= where the male's coupling barrel meets the
 *  female receptacle, which is the physical "port" for connection
 *  purposes). Matches the procedural connector length stack in
 *  `createSmaShortCable` (boot 3 + ferrule 3 + coupling 4 + PTFE 3.5
 *  + pin 2 ≈ 15.5 mm). Tweak together with that stack if either
 *  changes. */
export const RF_CONNECTOR_TIP_MM = 15.5;

function endpointIndex(end: "A" | "B", nodes: RfCableNodePersistent[]): number {
  return end === "A" ? 0 : nodes.length - 1;
}

/** Outward unit vector at one end of the spline (body-local mm space).
 *  For end A this is `-handleOut`, i.e. the direction the connector
 *  housing points (away from the curve body). For end B it's `-handleIn`.
 *  Falls back to the segment direction toward the neighbour if the
 *  handle is missing or zero-length. */
function endpointOutwardBodyLocal(
  nodes: RfCableNodePersistent[],
  end: "A" | "B",
): { x: number; y: number; z: number } {
  const idx = endpointIndex(end, nodes);
  const neighbourIdx = end === "A" ? 1 : nodes.length - 2;
  const node = nodes[idx];
  const neighbour = nodes[neighbourIdx];
  const handle = end === "A" ? node.handleOutMm : node.handleInMm;
  if (handle && handle[0] ** 2 + handle[1] ** 2 + handle[2] ** 2 > 1e-9) {
    const mag = Math.hypot(handle[0], handle[1], handle[2]);
    return { x: -handle[0] / mag, y: -handle[1] / mag, z: -handle[2] / mag };
  }
  const dx = node.posMm[0] - neighbour.posMm[0];
  const dy = node.posMm[1] - neighbour.posMm[1];
  const dz = node.posMm[2] - neighbour.posMm[2];
  const mag = Math.hypot(dx, dy, dz);
  if (mag < 1e-9) return { x: 1, y: 0, z: 0 };
  return { x: dx / mag, y: dy / mag, z: dz / mag };
}

/** Effective body-local position of an anchor — derived from the rf_cable
 *  spline endpoint + connector tip offset when `derivedFromRfCableEndpoint`
 *  is set and the spline is available; otherwise the stored
 *  `positionMmBodyLocal`. */
export function resolveRfCableAnchorPosition(
  anchor: Anchor,
  rfCableNodes: RfCableNodePersistent[] | undefined,
): { x: number; y: number; z: number } {
  const end = anchor.derivedFromRfCableEndpoint;
  if (!end || !rfCableNodes || rfCableNodes.length < 2) {
    return anchor.positionMmBodyLocal;
  }
  const idx = endpointIndex(end, rfCableNodes);
  const base = rfCableNodes[idx].posMm;
  const outward = endpointOutwardBodyLocal(rfCableNodes, end);
  return {
    x: base[0] + outward.x * RF_CONNECTOR_TIP_MM,
    y: base[1] + outward.y * RF_CONNECTOR_TIP_MM,
    z: base[2] + outward.z * RF_CONNECTOR_TIP_MM,
  };
}

/** Effective body-local direction of an anchor. For derived rf_cable
 *  ports this is the spline tangent at the endpoint, oriented outward
 *  (away from the cable body). Falls back to `directionBodyLocal`
 *  (or +X when that's missing — SMA cables conventionally extend
 *  along the cable axis). */
export function resolveRfCableAnchorDirection(
  anchor: Anchor,
  rfCableNodes: RfCableNodePersistent[] | undefined,
): { x: number; y: number; z: number } {
  const end = anchor.derivedFromRfCableEndpoint;
  if (!end || !rfCableNodes || rfCableNodes.length < 2) {
    return anchor.directionBodyLocal ?? { x: 1, y: 0, z: 0 };
  }
  return endpointOutwardBodyLocal(rfCableNodes, end);
}

/** Pulls the resolved rfCableNodes off a SceneObject's properties,
 *  falling back to the Component catalog template for legacy data.
 *  Mirrors the precedence used by `resolveFiberNodes`. */
export function resolveRfCableNodes(
  objectProperties: unknown,
  componentProperties: unknown,
): RfCableNodePersistent[] | undefined {
  const objNodes = (objectProperties as { rfCableNodes?: RfCableNodePersistent[] } | null | undefined)
    ?.rfCableNodes;
  if (Array.isArray(objNodes) && objNodes.length >= 2) return objNodes;
  const compNodes = (componentProperties as { rfCableNodes?: RfCableNodePersistent[] } | null | undefined)
    ?.rfCableNodes;
  if (Array.isArray(compNodes) && compNodes.length >= 2) return compNodes;
  return undefined;
}

type CablePose = {
  xMm: number; yMm: number; zMm: number;
  rxDeg: number; ryDeg: number; rzDeg: number;
};

type Vec3T = [number, number, number];

function makePoseTransforms(pose: CablePose) {
  const rxr = (pose.rxDeg * Math.PI) / 180;
  const ryr = (pose.ryDeg * Math.PI) / 180;
  const rzr = (pose.rzDeg * Math.PI) / 180;
  const cx = Math.cos(rxr), sxr = Math.sin(rxr);
  const cy = Math.cos(ryr), syr = Math.sin(ryr);
  const cz = Math.cos(rzr), szr = Math.sin(rzr);
  const bodyToLab = (v: Vec3T): Vec3T => {
    const x1 = cy * v[0] + syr * v[2];
    const y1 = v[1];
    const z1 = -syr * v[0] + cy * v[2];
    const x2 = x1;
    const y2 = cx * y1 - sxr * z1;
    const z2 = sxr * y1 + cx * z1;
    return [pose.xMm + cz * x2 - szr * y2, pose.yMm + szr * x2 + cz * y2, pose.zMm + z2];
  };
  const bodyToLabDir = (v: Vec3T): Vec3T => {
    const x1 = cy * v[0] + syr * v[2];
    const y1 = v[1];
    const z1 = -syr * v[0] + cy * v[2];
    const x2 = x1;
    const y2 = cx * y1 - sxr * z1;
    const z2 = sxr * y1 + cx * z1;
    return [cz * x2 - szr * y2, szr * x2 + cz * y2, z2];
  };
  const labToBody = (v: Vec3T): Vec3T => {
    const dx = v[0] - pose.xMm, dy = v[1] - pose.yMm, dz = v[2] - pose.zMm;
    const x2 = cz * dx + szr * dy;
    const y2 = -szr * dx + cz * dy;
    const z2 = dz;
    const y1 = cx * y2 + sxr * z2;
    const z1 = -sxr * y2 + cx * z2;
    return [cy * x2 - syr * z1, y1, syr * x2 + cy * z1];
  };
  const labToBodyDir = (v: Vec3T): Vec3T => {
    const x2 = cz * v[0] + szr * v[1];
    const y2 = -szr * v[0] + cz * v[1];
    const z2 = v[2];
    const y1 = cx * y2 + sxr * z2;
    const z1 = -sxr * y2 + cx * z2;
    return [cy * x2 - syr * z1, y1, syr * x2 + cy * z1];
  };
  return { bodyToLab, bodyToLabDir, labToBody, labToBodyDir };
}

/** Given an rf_cable endpoint link (which target SceneObject's anchor
 *  this end is mated to) plus the live pose of that target + the live
 *  cable's own pose, return the body-local spline node + handle that
 *  put the cable's end-port AT the target anchor lab position with
 *  outward anti-parallel to target's outward (the "點重合 方向相反"
 *  invariant from the user's align spec).
 *
 *  Returns null when the link can't be resolved (target SceneObject /
 *  asset / anchor missing). Caller falls back to the stored node array
 *  in that case so the cable still renders sensibly. */
export function resolveLinkedRfCableEndpoint(args: {
  endpoint: "A" | "B";
  cablePose: CablePose;
  /** Target SceneObject's live pose. */
  targetPose: CablePose;
  /** Target asset anchor's body-local position (mm). */
  targetAnchorPosBodyMm: Vec3T;
  /** Target asset anchor's body-local outward direction unit vector. */
  targetAnchorDirBody: Vec3T;
  /** Magnitude of the handle vector to set on the linked endpoint
   *  (preserves manual handle when caller passes the existing magnitude;
   *  defaults to 30 mm — same as the align helper). */
  handleMagnitudeMm?: number;
}): {
  posMmBody: Vec3T;
  /** Inward-pointing handle vector (handleOut for end A, handleIn for B). */
  handleMmBody: Vec3T;
} | null {
  const { endpoint, cablePose, targetPose, targetAnchorPosBodyMm, targetAnchorDirBody } = args;
  const targetT = makePoseTransforms(targetPose);
  const cableT = makePoseTransforms(cablePose);
  const targetAnchorLab = targetT.bodyToLab(targetAnchorPosBodyMm);
  const targetOutwardLab = targetT.bodyToLabDir(targetAnchorDirBody);
  const mag = Math.hypot(targetOutwardLab[0], targetOutwardLab[1], targetOutwardLab[2]);
  if (mag < 1e-9) return null;
  const targetOutwardUnit: Vec3T = [
    targetOutwardLab[0] / mag, targetOutwardLab[1] / mag, targetOutwardLab[2] / mag,
  ];
  // Cable's new outward (lab) = anti-parallel to target.
  const newOutwardLab: Vec3T = [-targetOutwardUnit[0], -targetOutwardUnit[1], -targetOutwardUnit[2]];
  // Node lab so port = target: node = target - outward · TIP.
  const newNodeLab: Vec3T = [
    targetAnchorLab[0] - newOutwardLab[0] * RF_CONNECTOR_TIP_MM,
    targetAnchorLab[1] - newOutwardLab[1] * RF_CONNECTOR_TIP_MM,
    targetAnchorLab[2] - newOutwardLab[2] * RF_CONNECTOR_TIP_MM,
  ];
  const posMmBody = cableT.labToBody(newNodeLab);
  const newOutwardBody = cableT.labToBodyDir(newOutwardLab);
  const handleMag = args.handleMagnitudeMm ?? 30;
  const handleMmBody: Vec3T = [
    -newOutwardBody[0] * handleMag,
    -newOutwardBody[1] * handleMag,
    -newOutwardBody[2] * handleMag,
  ];
  // Endpoint is consumed by the caller (which side of the node array to
  // overwrite); we just return the value pair.
  void endpoint;
  return { posMmBody, handleMmBody };
}
