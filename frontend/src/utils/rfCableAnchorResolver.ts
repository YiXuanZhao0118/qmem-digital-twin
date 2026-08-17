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
import {
  dirBodyToLab,
  dirLabToBody,
  pointBodyToLab,
  pointLabToBody,
} from "../optical/pose";

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

/** BNC-male equivalent of {@link RF_CONNECTOR_TIP_MM}. The BNC plug is a
 *  longer stack than SMA — matches `buildBncMaleConnectorGroup`
 *  (boot 4 + ferrule 5 + bayonet sleeve 12 + PTFE 3 + pin 3 = 27 mm).
 *  Tweak together with that builder if it changes. */
export const RF_BNC_CONNECTOR_TIP_MM = 27;

/** Tip length for a connector family string ("sma" / "bnc" / "sma_male"
 *  / "bnc_female" / …). Defaults to the SMA length for anything that
 *  doesn't read as BNC. */
export function connectorTipMmForFamily(family: string | null | undefined): number {
  return typeof family === "string" && family.toLowerCase().startsWith("bnc")
    ? RF_BNC_CONNECTOR_TIP_MM
    : RF_CONNECTOR_TIP_MM;
}

/** Tip offset (mm) derived from a connector asset's own anchors =
 *  |connect_in − connect_out|. This is EXACTLY where the connector bake
 *  (`bakeConnectorByAnchors`) places the mating face (connect_in) ahead of
 *  connect_out, which sits on the cable spline node. Backing the node off the
 *  target by this value makes connect_in land on the target port — the
 *  hardcoded family constants (`connectorTipMmForFamily`) only match the
 *  *procedural* connectors, not the imported device GLBs (sma_male's real
 *  offset is 25.45 mm, not 15.5; bnc_male's is 43.5, not 27). Falls back to
 *  the family constant when the connector has no connect_out/connect_in
 *  anchors (procedural / placeholder asset). */
export function connectorTipMmFromAnchors(
  anchors: readonly Anchor[] | null | undefined,
  family: string | null | undefined,
): number {
  const co = anchors?.find((a) => a.id === "connect_out")?.positionMmBodyLocal;
  const ci = anchors?.find((a) => a.id === "connect_in")?.positionMmBodyLocal;
  if (co && ci) {
    const d = Math.hypot(ci.x - co.x, ci.y - co.y, ci.z - co.z);
    if (d > 1e-6) return d;
  }
  return connectorTipMmForFamily(family);
}

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
  return {
    bodyToLab: (v: Vec3T): Vec3T => {
      const out = pointBodyToLab({ x: v[0], y: v[1], z: v[2] }, pose);
      return [out.x, out.y, out.z];
    },
    bodyToLabDir: (v: Vec3T): Vec3T => {
      const out = dirBodyToLab({ x: v[0], y: v[1], z: v[2] }, pose);
      return [out.x, out.y, out.z];
    },
    labToBody: (v: Vec3T): Vec3T => {
      const out = pointLabToBody({ x: v[0], y: v[1], z: v[2] }, pose);
      return [out.x, out.y, out.z];
    },
    labToBodyDir: (v: Vec3T): Vec3T => {
      const out = dirLabToBody({ x: v[0], y: v[1], z: v[2] }, pose);
      return [out.x, out.y, out.z];
    },
  };
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
 *  outward anti-parallel to target's outward (the "coincident points, opposite directions"
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
  /** Connector tip length for THIS cable end (SMA 15.5 / BNC 27 mm). The
   *  node sits this far back from the port so the male connector face
   *  lands on it. Defaults to the SMA length — callers pass the BNC
   *  length for bnc-ended cables (see {@link connectorTipMmForFamily}). */
  connectorTipMm?: number;
  /** Manual node nudge for THIS cable end, in the connector frame
   *  (Z = outward / facing direction). depthMm = along the connector axis
   *  (in/out of the port); sideXMm / sideYMm = perpendicular plane. The
   *  caller keys these per cable + end so each connector can be tuned
   *  independently (see the offset table in DigitalTwinViewer). */
  nodeOffset?: { depthMm?: number; sideXMm?: number; sideYMm?: number };
  /** Target anchor's body-local axisY. When supplied, the side (sideX /
   *  sideY) basis is built from it (transformed to lab) so the perpendicular
   *  plane co-moves with the target instrument — the same offset looks
   *  identical at any orientation. Falls back to an arbitrary perpendicular
   *  when absent. */
  targetAnchorAxisYBody?: Vec3T;
}): {
  posMmBody: Vec3T;
  /** Inward-pointing handle vector (handleOut for end A, handleIn for B). */
  handleMmBody: Vec3T;
} | null {
  const { endpoint, cablePose, targetPose, targetAnchorPosBodyMm, targetAnchorDirBody } = args;
  const tipMm = args.connectorTipMm ?? RF_CONNECTOR_TIP_MM;
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
    targetAnchorLab[0] - newOutwardLab[0] * tipMm,
    targetAnchorLab[1] - newOutwardLab[1] * tipMm,
    targetAnchorLab[2] - newOutwardLab[2] * tipMm,
  ];

  // Per-cable/per-end manual nudge (same idea as the PPG #3 nudge): build a
  // connector frame with Z = outward (the cable's facing direction at this
  // end) and shift the node within it. The caller keys the values per
  // cable + end (see DigitalTwinViewer's offset table), so each connector
  // tunes independently. Default = no offset.
  const off = {
    depthMm: args.nodeOffset?.depthMm ?? 0,
    sideXMm: args.nodeOffset?.sideXMm ?? 0,
    sideYMm: args.nodeOffset?.sideYMm ?? 0,
  };
  const zc = newOutwardLab; // already a unit vector
  const cross = (a: Vec3T, b: Vec3T): Vec3T => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (v: Vec3T): Vec3T => {
    const m = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / m, v[1] / m, v[2] / m];
  };
  // Side basis tied to the TARGET anchor's axisY (in lab) so the
  // perpendicular plane co-moves with the instrument — same sideX/sideY
  // looks identical at any orientation. Project axisY off the mating axis
  // (zc) first; fall back to an arbitrary perpendicular if axisY is absent
  // or parallel to zc.
  let yc: Vec3T;
  if (args.targetAnchorAxisYBody) {
    const aYLab = targetT.bodyToLabDir(args.targetAnchorAxisYBody);
    const d = aYLab[0] * zc[0] + aYLab[1] * zc[1] + aYLab[2] * zc[2];
    const proj: Vec3T = [aYLab[0] - d * zc[0], aYLab[1] - d * zc[1], aYLab[2] - d * zc[2]];
    yc = Math.hypot(proj[0], proj[1], proj[2]) > 1e-6
      ? norm(proj)
      : norm(cross(Math.abs(zc[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], zc));
  } else {
    yc = norm(cross(Math.abs(zc[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], zc));
  }
  const xc = norm(cross(yc, zc));
  newNodeLab[0] += zc[0] * off.depthMm + xc[0] * off.sideXMm + yc[0] * off.sideYMm;
  newNodeLab[1] += zc[1] * off.depthMm + xc[1] * off.sideXMm + yc[1] * off.sideYMm;
  newNodeLab[2] += zc[2] * off.depthMm + xc[2] * off.sideXMm + yc[2] * off.sideYMm;

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
