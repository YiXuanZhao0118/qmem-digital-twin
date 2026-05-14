// Pure geometric helper behind `sceneStore.alignRfCableEndToPort`.
// Parallels `fiberAlignment.ts` but snaps an rf_cable endpoint to the
// closest RF port anchor (rf_in / rf_out on an AOM / AD9959 / horn /
// any other SceneObject in the scene) instead of projecting onto an
// optical beam segment — RF doesn't have a continuous beam-path
// representation, so the natural snap target is a port point.
//
// What "align" means for an rf_cable:
//   1. The mating face (port) at endpoint A or B is `node + outward ·
//      RF_CONNECTOR_TIP_MM` — same offset trick as fiber's ferrule tip.
//   2. Find the closest RF port anchor in `ports` (already converted to
//      lab frame) within `toleranceMm` of the current cable port.
//   3. Move the cable node so its port lands AT the target port, with
//      the cable's outward direction = `-target.labDirOutward` (the male
//      connector faces INTO the female receptacle, anti-parallel mating).
//   4. Set the matching handle so the spline tangent at the endpoint
//      matches the new outward direction.

import { RF_CONNECTOR_TIP_MM } from "./rfCableAnchorResolver";

export type Vec3Tuple = [number, number, number];

export interface FiberNodePersist {
  posMm: Vec3Tuple;
  handleInMm?: Vec3Tuple;
  handleOutMm?: Vec3Tuple;
}

export interface RfCablePose {
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
}

export interface RfPortLab {
  /** Lab-frame position of the port anchor (mm). */
  labPosMm: Vec3Tuple;
  /** Outward direction in lab frame (the way the female receptacle's
   *  face normal points). Cable mates anti-parallel to this. */
  labDirOutward: Vec3Tuple;
  /** Display label / scene-object id of the target — surfaced to the UI
   *  for "snapped to <name>" feedback. */
  targetName: string;
  targetObjectId: string;
  targetAnchorName: string;
  /** Anchor id on the target asset — `rf_in` or `rf_out`. */
  targetAnchorId: string;
}

export interface RfCableAlignmentResult {
  distMm: number;
  /** New spline node body-local position (write to nodes[idx].posMm). */
  newPosMmBody: Vec3Tuple;
  /** New handle vector (write to nodes[idx].handleOutMm for End A or
   *  nodes[idx].handleInMm for End B). */
  newHandleMmBody: Vec3Tuple;
  targetName: string;
  targetObjectId: string;
  targetAnchorName: string;
  /** Anchor id on the target asset — `rf_in` or `rf_out`. Surfaced to the
   *  UI so the picker can label each candidate by socket type and prevent
   *  ambiguity when several `rf_out` channels of the same component
   *  (e.g. AD9959 CH0..CH3) cluster within tolerance. */
  targetAnchorId: string;
}

function makePoseTransforms(pose: RfCablePose) {
  const rxr = (pose.rxDeg * Math.PI) / 180;
  const ryr = (pose.ryDeg * Math.PI) / 180;
  const rzr = (pose.rzDeg * Math.PI) / 180;
  const cx = Math.cos(rxr), sxr = Math.sin(rxr);
  const cy = Math.cos(ryr), syr = Math.sin(ryr);
  const cz = Math.cos(rzr), szr = Math.sin(rzr);
  // Body → lab: lab = pose + R_z · R_x · R_y · body
  const bodyToLab = (v: Vec3Tuple): Vec3Tuple => {
    const x1 = cy * v[0] + syr * v[2];
    const y1 = v[1];
    const z1 = -syr * v[0] + cy * v[2];
    const x2 = x1;
    const y2 = cx * y1 - sxr * z1;
    const z2 = sxr * y1 + cx * z1;
    const x3 = cz * x2 - szr * y2;
    const y3 = szr * x2 + cz * y2;
    const z3 = z2;
    return [pose.xMm + x3, pose.yMm + y3, pose.zMm + z3];
  };
  const bodyToLabDir = (v: Vec3Tuple): Vec3Tuple => {
    const x1 = cy * v[0] + syr * v[2];
    const y1 = v[1];
    const z1 = -syr * v[0] + cy * v[2];
    const x2 = x1;
    const y2 = cx * y1 - sxr * z1;
    const z2 = sxr * y1 + cx * z1;
    return [cz * x2 - szr * y2, szr * x2 + cz * y2, z2];
  };
  // Lab → body: inverse of the above (transpose of rotation since orthonormal).
  const labToBody = (v: Vec3Tuple): Vec3Tuple => {
    const dx = v[0] - pose.xMm;
    const dy = v[1] - pose.yMm;
    const dz = v[2] - pose.zMm;
    const x2 = cz * dx + szr * dy;
    const y2 = -szr * dx + cz * dy;
    const z2 = dz;
    const x1 = x2;
    const y1 = cx * y2 + sxr * z2;
    const z1 = -sxr * y2 + cx * z2;
    return [cy * x1 - syr * z1, y1, syr * x1 + cy * z1];
  };
  const labToBodyDir = (v: Vec3Tuple): Vec3Tuple => {
    const x2 = cz * v[0] + szr * v[1];
    const y2 = -szr * v[0] + cz * v[1];
    const z2 = v[2];
    const x1 = x2;
    const y1 = cx * y2 + sxr * z2;
    const z1 = -sxr * y2 + cx * z2;
    return [cy * x1 - syr * z1, y1, syr * x1 + cy * z1];
  };
  return { bodyToLab, bodyToLabDir, labToBody, labToBodyDir };
}

function normalise(v: Vec3Tuple): Vec3Tuple {
  const m = Math.hypot(v[0], v[1], v[2]);
  if (m < 1e-9) return [1, 0, 0];
  return [v[0] / m, v[1] / m, v[2] / m];
}

function endpointOutwardBody(
  nodes: FiberNodePersist[],
  end: "A" | "B",
): Vec3Tuple {
  // Same convention as the renderer: outward at end A is -handleOut (or
  // -segmentToNeighbour if handle missing); end B is -handleIn.
  const idx = end === "A" ? 0 : nodes.length - 1;
  const neighbourIdx = end === "A" ? 1 : nodes.length - 2;
  const node = nodes[idx];
  const neighbour = nodes[neighbourIdx];
  const handle = end === "A" ? node.handleOutMm : node.handleInMm;
  if (handle && handle[0] ** 2 + handle[1] ** 2 + handle[2] ** 2 > 1e-9) {
    return normalise([-handle[0], -handle[1], -handle[2]]);
  }
  return normalise([
    node.posMm[0] - neighbour.posMm[0],
    node.posMm[1] - neighbour.posMm[1],
    node.posMm[2] - neighbour.posMm[2],
  ]);
}

/** Build all rf_cable endpoint alignment candidates within `toleranceMm`,
 *  sorted ascending by distance from the current cable port. Callers use
 *  this to:
 *    - auto-snap when exactly one candidate is in range (UI calls the
 *      apply helper on `candidates[0]` directly), or
 *    - show a picker dropdown when several candidates cluster (e.g.
 *      AD9959's CH0..CH3 all within mm of each other).
 *  Each candidate already carries the new body-local node + handle so
 *  applying is just stitching the result back into the nodes array. */
export function findRfCableEndpointAlignmentCandidates(args: {
  endpoint: "A" | "B";
  cablePose: RfCablePose;
  cableNodes: FiberNodePersist[];
  ports: RfPortLab[];
  toleranceMm: number;
  /** Magnitude (mm) of the handle vector to set on the aligned endpoint.
   *  Falls back to the existing handle's magnitude if present, else 30. */
  handleMagnitudeMm?: number;
}): RfCableAlignmentResult[] {
  const { endpoint, cablePose, cableNodes, ports, toleranceMm } = args;
  if (cableNodes.length < 2) return [];
  const { bodyToLab, bodyToLabDir, labToBody, labToBodyDir } = makePoseTransforms(cablePose);

  const idx = endpoint === "A" ? 0 : cableNodes.length - 1;
  const node = cableNodes[idx];
  const outwardBody = endpointOutwardBody(cableNodes, endpoint);
  const outwardLab = bodyToLabDir(outwardBody);
  const nodeLab = bodyToLab(node.posMm);
  const portLab: Vec3Tuple = [
    nodeLab[0] + outwardLab[0] * RF_CONNECTOR_TIP_MM,
    nodeLab[1] + outwardLab[1] * RF_CONNECTOR_TIP_MM,
    nodeLab[2] + outwardLab[2] * RF_CONNECTOR_TIP_MM,
  ];

  const existingHandle = endpoint === "A" ? node.handleOutMm : node.handleInMm;
  const existingMag = existingHandle
    ? Math.hypot(existingHandle[0], existingHandle[1], existingHandle[2])
    : 0;
  const mag = args.handleMagnitudeMm ?? (existingMag > 1e-6 ? existingMag : 30);

  const results: RfCableAlignmentResult[] = [];
  for (const p of ports) {
    const dx = p.labPosMm[0] - portLab[0];
    const dy = p.labPosMm[1] - portLab[1];
    const dz = p.labPosMm[2] - portLab[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > toleranceMm) continue;

    const targetOutwardLab = normalise(p.labDirOutward);
    const newOutwardLab: Vec3Tuple = [
      -targetOutwardLab[0], -targetOutwardLab[1], -targetOutwardLab[2],
    ];
    const newNodeLab: Vec3Tuple = [
      p.labPosMm[0] - newOutwardLab[0] * RF_CONNECTOR_TIP_MM,
      p.labPosMm[1] - newOutwardLab[1] * RF_CONNECTOR_TIP_MM,
      p.labPosMm[2] - newOutwardLab[2] * RF_CONNECTOR_TIP_MM,
    ];
    const newPosMmBody = labToBody(newNodeLab);
    const newOutwardBody = labToBodyDir(newOutwardLab);
    const newHandleMmBody: Vec3Tuple = [
      -newOutwardBody[0] * mag,
      -newOutwardBody[1] * mag,
      -newOutwardBody[2] * mag,
    ];
    results.push({
      distMm: d,
      newPosMmBody,
      newHandleMmBody,
      targetName: p.targetName,
      targetObjectId: p.targetObjectId,
      targetAnchorName: p.targetAnchorName,
      targetAnchorId: p.targetAnchorId,
    });
  }
  results.sort((a, b) => a.distMm - b.distMm);
  return results;
}

/** Back-compat shim: closest single candidate or null. Will be removed
 *  once all callers migrate to findRfCableEndpointAlignmentCandidates. */
export function alignRfCableEndpointToPort(args: Parameters<typeof findRfCableEndpointAlignmentCandidates>[0]): RfCableAlignmentResult | null {
  const list = findRfCableEndpointAlignmentCandidates(args);
  return list[0] ?? null;
}
