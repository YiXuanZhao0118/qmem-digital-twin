// Pure geometric helper behind `sceneStore.alignFiberEndToBeam`. Extracted
// 2026-05-12 so the projection math can be tested without spinning up the
// Zustand store + REST round-trip.
//
// What "align" means for a fiber:
//   1. The optical PORT (intercept_in for End A / intercept_out for End B,
//      at the ferrule tip = node + outward · FIBER_FERRULE_TIP_MM) is the
//      thing the user wants on the beam — NOT the spline node, which sits
//      36.28 mm behind the port along the outward direction.
//   2. Project the current port lab position onto every supplied beam
//      segment, keep the closest if it's within `toleranceMm`.
//   3. Back-derive the new spline node so the port lands exactly on the
//      projected point with the new outward direction:
//        End A entry: outward_new = −beam_tangent (face opposes beam)
//        End B exit:  outward_new = +beam_tangent (face goes with beam)
//      node_new = projected_port − outward_new · FIBER_FERRULE_TIP_MM
//   4. Set the matching handle so the spline tangent at the endpoint
//      matches the beam direction: handleOut_A = +beam_tangent,
//      handleIn_B = −beam_tangent. Handle MAGNITUDE is preserved from the
//      previous handle when present; falls back to 1/3 of the segment to
//      the neighbour, floored at 20 mm.
//
// Rotation convention: matches the rest of sceneStore's body↔lab math
// (lab = pose + R_z · R_x · R_y · body). Kept inline rather than calling
// `bodyLocalDirToLabDir` so this module stays self-contained / testable.

import {
  dirBodyToLab,
  dirLabToBody,
  pointBodyToLab,
  pointLabToBody,
} from "../optical/pose";
import { FIBER_FERRULE_TIP_MM, FIBER_MATING_GAP_MM } from "./fiberAnchorResolver";

export type Vec3Tuple = [number, number, number];

export interface FiberNodePersist {
  posMm: Vec3Tuple;
  handleInMm?: Vec3Tuple;
  handleOutMm?: Vec3Tuple;
}

export interface FiberAlignPose {
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
}

export interface BeamSegmentLab {
  beamId: string;
  aMm: Vec3Tuple;
  bMm: Vec3Tuple;
  /** Display label shown in the multi-candidate picker. Lets the caller
   *  encode source + AOM order + wavelength etc.; falls back to beamId
   *  when undefined. */
  displayLabel?: string;
  /** Original emitter (laser / TA) SceneObject id — used by the store to
   *  group multi-segment beam chains under one candidate. */
  emitterObjectId?: string;
  /** AOM diffraction order if this segment came out of an AOM (… −1, 0,
   *  +1 …). null/undefined when not from an AOM. Critical for snapping
   *  to a specific Bragg sideband when 0/±1 orders are all within
   *  tolerance — without this all three look indistinguishable in the
   *  picker. */
  aomOrder?: number | null;
  /** Visualisation branch — "main" / "transmitted" / "reflected". Used
   *  for picker disambiguation when a beam splitter produces two paths
   *  through the same tolerance window. */
  branch?: string;
  wavelengthNm?: number;
}

export interface FiberEndAlignmentResult {
  beamId: string;
  distMm: number;
  /** Lab position where the port now lands (= projection of the current
   *  port onto the best beam segment, clamped to the segment). */
  projectedPortLab: Vec3Tuple;
  /** New spline node body-local position (write to nodes[idx].posMm). */
  newPosMmBody: Vec3Tuple;
  /** New handle vector (write to nodes[idx].handleOutMm for End A or
   *  nodes[idx].handleInMm for End B). The other handle on this node is
   *  preserved and should be copied by the caller. */
  newHandleMmBody: Vec3Tuple;
  /** New outward body-local direction = -newHandleMmBody / |.|. Exposed
   *  so callers / tests can check the entry-face-vs-beam invariant
   *  without re-deriving it. */
  newOutwardBody: Vec3Tuple;
}

/** One picker entry — same alignment payload as `FiberEndAlignmentResult`
 *  plus metadata for the UI label. Returned by
 *  `findFiberEndAlignmentCandidates` sorted ascending by `distMm`. */
export interface FiberAlignmentCandidate extends FiberEndAlignmentResult {
  displayLabel?: string;
  emitterObjectId?: string;
  aomOrder?: number | null;
  branch?: string;
  wavelengthNm?: number;
  /** Present only on candidates produced by
   *  {@link findFiberPortAlignmentCandidates} — i.e. the end is being
   *  plugged into a fibre receptacle rather than parked on a beam. The
   *  store persists this as `SceneObject.properties.fiberEndpoints[end]`
   *  so the end follows the instrument; a beam candidate has no `port`
   *  and CLEARS any existing link (manual/beam align beats link). */
  port?: FiberPortLink;
}

/** Identity of the fibre receptacle a candidate plugs into. Mirrors
 *  `RfCableEndpointLink`'s payload. */
export interface FiberPortLink {
  targetObjectId: string;
  targetAnchorId: string;
  targetAnchorName: string;
}

/** One fibre receptacle in LAB frame, ready to snap onto. The optical twin
 *  of `RfPortLab` in `rfCableAlignment.ts`. */
export interface FiberPortLab extends FiberPortLink {
  /** Lab position of the port's optical face (mm). */
  labPosMm: Vec3Tuple;
  /** Lab-frame axisX of the port anchor — for an optical anchor this is the
   *  PROPAGATION direction, not a mechanical outward normal (anchors.md).
   *  A fibre End A mates facing −axisX, End B facing +axisX. */
  labAxisX: Vec3Tuple;
  /** Owning SceneObject's display name, for the picker label. */
  targetName: string;
}

/** True when an anchor's `connectorType` names a fibre bulkhead, i.e. the
 *  anchor is a receptacle a patch cable can be plugged into rather than a
 *  free-space optical face. Deliberately prefix-based like
 *  `connectorFamilyFromAnchor` in `rfLinkPorts.ts`, so adding `sc_*` /
 *  `lc_*` to the union needs no change here.
 *
 *  **Female only** (2026-08-23). A receptacle is a socket on a chassis; the
 *  ferrule on the end of a patch cable or a pigtail is a PLUG and carries
 *  `*_male`. This matters because `collectFiberPortsLab` filters on this
 *  predicate alone and never looks at the anchor id — once cable ends
 *  declare their connector, a gender-blind test would list every one of
 *  them as a socket and let two patch cables be plugged into each other. */
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

function makePoseTransforms(pose: FiberAlignPose) {
  return {
    bodyToLab: (v: Vec3Tuple): Vec3Tuple => {
      const out = pointBodyToLab({ x: v[0], y: v[1], z: v[2] }, pose);
      return [out.x, out.y, out.z];
    },
    labToBody: (v: Vec3Tuple): Vec3Tuple => {
      const out = pointLabToBody({ x: v[0], y: v[1], z: v[2] }, pose);
      return [out.x, out.y, out.z];
    },
    rotateLabDirToBody: (v: Vec3Tuple): Vec3Tuple => {
      const out = dirLabToBody({ x: v[0], y: v[1], z: v[2] }, pose);
      return [out.x, out.y, out.z];
    },
    rotateBodyDirToLab: (v: Vec3Tuple): Vec3Tuple => {
      const out = dirBodyToLab({ x: v[0], y: v[1], z: v[2] }, pose);
      return [out.x, out.y, out.z];
    },
  };
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
    const y2 = cx * y1 - sxr * z1;
    const z2 = sxr * y1 + cx * z1;
    const xL = cz * x1 - szr * y2;
    const yL = szr * x1 + cz * y2;
    return [pose.xMm + xL, pose.yMm + yL, pose.zMm + z2];
  };
  // Lab → body: inverse rotation (R_y^T · R_x^T · R_z^T) then subtract pose.
  const labToBody = (lab: Vec3Tuple): Vec3Tuple => {
    const x = lab[0] - pose.xMm;
    const y = lab[1] - pose.yMm;
    const z = lab[2] - pose.zMm;
    const x1 = cz * x + szr * y;
    const y1 = -szr * x + cz * y;
    const z1 = z;
    const y2 = cx * y1 + sxr * z1;
    const z2 = -sxr * y1 + cx * z1;
    return [cy * x1 - syr * z2, y2, syr * x1 + cy * z2];
  };
  // Direction-only inverse rotation (no translation).
  const rotateLabDirToBody = (v: Vec3Tuple): Vec3Tuple => {
    const x1 = cz * v[0] + szr * v[1];
    const y1 = -szr * v[0] + cz * v[1];
    const z1 = v[2];
    const y2 = cx * y1 + sxr * z1;
    const z2 = -sxr * y1 + cx * z1;
    return [cy * x1 - syr * z2, y2, syr * x1 + cy * z2];
  };
  // Direction-only forward rotation (body dir → lab dir, no translation).
  const rotateBodyDirToLab = (v: Vec3Tuple): Vec3Tuple => {
    const x1 = cy * v[0] + syr * v[2];
    const y1 = v[1];
    const z1 = -syr * v[0] + cy * v[2];
    const y2 = cx * y1 - sxr * z1;
    const z2 = sxr * y1 + cx * z1;
    const xL = cz * x1 - szr * y2;
    const yL = szr * x1 + cz * y2;
    return [xL, yL, z2];
  };
  return { bodyToLab, labToBody, rotateLabDirToBody, rotateBodyDirToLab };
}

/** Current outward direction at the endpoint in BODY frame. Matches
 *  `fiberAnchorResolver.endpointOutwardBodyLocal`: −handle when present,
 *  else segment direction toward the neighbour, else +Y as a last
 *  resort. Exported for tests. */
export function endpointOutwardBody(
  nodes: FiberNodePersist[],
  end: "A" | "B",
): Vec3Tuple {
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

/** Run the full port-aware projection. Returns null when no beam segment
 *  is within tolerance. Caller is responsible for stitching the result
 *  back into the persisted fiberNodes array and pushing through the
 *  store.
 *
 *  Thin wrapper around `findFiberEndAlignmentCandidates` — returns the
 *  closest candidate (or null when nothing is in range). Kept for the
 *  one-shot back-compat caller `sceneStore.alignFiberEndToBeam` and the
 *  pinning tests in `utils/__tests__/fiberAlignment.test.ts`. New code
 *  (multi-candidate picker — see `findFiberAlignmentCandidates` in the
 *  store) should call the list version directly. */
export function computeFiberEndAlignment(opts: {
  end: "A" | "B";
  nodes: FiberNodePersist[];
  pose: FiberAlignPose;
  beamSegmentsLab: BeamSegmentLab[];
  toleranceMm: number;
}): FiberEndAlignmentResult | null {
  const list = findFiberEndAlignmentCandidates(opts);
  if (list.length === 0) return null;
  const closest = list[0];
  return {
    beamId: closest.beamId,
    distMm: closest.distMm,
    projectedPortLab: closest.projectedPortLab,
    newPosMmBody: closest.newPosMmBody,
    newHandleMmBody: closest.newHandleMmBody,
    newOutwardBody: closest.newOutwardBody,
  };
}

/** Build all candidate beam segments within `toleranceMm` of the fiber
 *  endpoint's optical port, sorted ascending by distance. Each entry
 *  already carries the body-local node + handle so applying is a stitch
 *  + write.
 *
 *  Used by the two-phase fiber align action (mirrors
 *  `findRfCableEndpointAlignmentCandidates`):
 *    - auto-snap when length === 1 (UI applies `[0]` directly)
 *    - show a picker dropdown when length >= 2 (AOM 0/±1 clustered
 *      orders, beam-splitter R+T branches, etc.) so the user explicitly
 *      chooses which beam to align to instead of the closest-wins coin
 *      toss the old single-result `computeFiberEndAlignment` did.
 *
 *  Optional `BeamSegmentLab.displayLabel / emitterObjectId / aomOrder /
 *  branch / wavelengthNm` are surfaced verbatim on the result so the
 *  caller can label each candidate without re-deriving them. */
export function findFiberEndAlignmentCandidates(opts: {
  end: "A" | "B";
  nodes: FiberNodePersist[];
  pose: FiberAlignPose;
  beamSegmentsLab: BeamSegmentLab[];
  toleranceMm: number;
}): FiberAlignmentCandidate[] {
  const { end, nodes, pose, beamSegmentsLab, toleranceMm } = opts;
  if (nodes.length < 2) return [];
  const idx = end === "A" ? 0 : nodes.length - 1;
  const neighbourIdx = end === "A" ? 1 : nodes.length - 2;
  const epBody = nodes[idx].posMm;

  const { bodyToLab, labToBody, rotateLabDirToBody } = makePoseTransforms(pose);

  // Current port lab position = node + outward · TIP, then bodyToLab.
  const outwardBody = endpointOutwardBody(nodes, end);
  const anchorBody: Vec3Tuple = [
    epBody[0] + outwardBody[0] * FIBER_FERRULE_TIP_MM,
    epBody[1] + outwardBody[1] * FIBER_FERRULE_TIP_MM,
    epBody[2] + outwardBody[2] * FIBER_FERRULE_TIP_MM,
  ];
  const anchorLab = bodyToLab(anchorBody);

  const oldNeighbour = nodes[neighbourIdx].posMm;
  const segLen = Math.hypot(
    oldNeighbour[0] - epBody[0],
    oldNeighbour[1] - epBody[1],
    oldNeighbour[2] - epBody[2],
  );
  const handleLen = Math.max(20, segLen * 0.33);
  const handleSign = end === "A" ? 1 : -1;

  const results: FiberAlignmentCandidate[] = [];
  for (const seg of beamSegmentsLab) {
    const ab: Vec3Tuple = [
      seg.bMm[0] - seg.aMm[0],
      seg.bMm[1] - seg.aMm[1],
      seg.bMm[2] - seg.aMm[2],
    ];
    const lenSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    if (lenSq < 1e-6) continue;
    const t =
      ((anchorLab[0] - seg.aMm[0]) * ab[0] +
        (anchorLab[1] - seg.aMm[1]) * ab[1] +
        (anchorLab[2] - seg.aMm[2]) * ab[2]) /
      lenSq;
    const tClamped = Math.max(0, Math.min(1, t));
    const projected: Vec3Tuple = [
      seg.aMm[0] + tClamped * ab[0],
      seg.aMm[1] + tClamped * ab[1],
      seg.aMm[2] + tClamped * ab[2],
    ];
    const distMm = Math.hypot(
      anchorLab[0] - projected[0],
      anchorLab[1] - projected[1],
      anchorLab[2] - projected[2],
    );
    if (distMm > toleranceMm) continue;
    const tanLen = Math.sqrt(lenSq);
    const tangentMm: Vec3Tuple = [ab[0] / tanLen, ab[1] / tanLen, ab[2] / tanLen];

    // Back-derive new node so the port lands on the projected point.
    const projectedAnchorBody = labToBody(projected);
    const tanBody = rotateLabDirToBody(tangentMm);
    const newOutwardBody: Vec3Tuple =
      end === "A"
        ? [-tanBody[0], -tanBody[1], -tanBody[2]]
        : [tanBody[0], tanBody[1], tanBody[2]];
    const newPosMmBody: Vec3Tuple = [
      projectedAnchorBody[0] - newOutwardBody[0] * FIBER_FERRULE_TIP_MM,
      projectedAnchorBody[1] - newOutwardBody[1] * FIBER_FERRULE_TIP_MM,
      projectedAnchorBody[2] - newOutwardBody[2] * FIBER_FERRULE_TIP_MM,
    ];
    const newHandleMmBody: Vec3Tuple = [
      handleSign * tanBody[0] * handleLen,
      handleSign * tanBody[1] * handleLen,
      handleSign * tanBody[2] * handleLen,
    ];

    results.push({
      beamId: seg.beamId,
      distMm,
      projectedPortLab: projected,
      newPosMmBody,
      newHandleMmBody,
      newOutwardBody,
      displayLabel: seg.displayLabel,
      emitterObjectId: seg.emitterObjectId,
      aomOrder: seg.aomOrder ?? null,
      branch: seg.branch,
      wavelengthNm: seg.wavelengthNm,
    });
  }
  results.sort((a, b) => a.distMm - b.distMm);
  return results;
}

/** Snap a fibre end onto a fibre RECEPTACLE instead of onto a beam segment
 *  — the optical twin of `findRfCableEndpointAlignmentCandidates`.
 *
 *  The mating rule is the same as coax: the end's optical face lands ON the
 *  port and the fibre's outward becomes ANTI-parallel to the port's outward
 *  (the ferrule slides into the receptacle facing it). Unlike the beam
 *  version there is no projection — a port is a point, so `distMm` is just
 *  how far the end currently is from it, used to rank and to reject beyond
 *  `toleranceMm`.
 *
 *  `tipMm` is the junction→optical-face distance of THIS end's connector. It
 *  defaults to the FC housing constant, but callers that know the bound
 *  connector asset should pass `|connect_in − connect_out|` — the same value
 *  the backend's `_connector_tip_and_aperture` uses to place the synthesized
 *  `intercept_in/out`. Passing the wrong tip puts the optical face short of
 *  (or past) the receptacle, which is exactly the ~10 mm overshoot the RF
 *  side hit with its hard-coded family constants.
 *
 *  Results are shaped as `FiberAlignmentCandidate` so they merge into the
 *  same picker list and flow through the same `applyFiberAlignmentCandidate`
 *  as beam candidates; `port` is what tells the store to persist a link. */
export function findFiberPortAlignmentCandidates(opts: {
  end: "A" | "B";
  nodes: FiberNodePersist[];
  pose: FiberAlignPose;
  ports: FiberPortLab[];
  toleranceMm: number;
  tipMm?: number;
}): FiberAlignmentCandidate[] {
  const { end, nodes, pose, ports, toleranceMm } = opts;
  if (nodes.length < 2) return [];
  const tipMm = opts.tipMm ?? FIBER_FERRULE_TIP_MM;
  const { bodyToLab, labToBody, rotateLabDirToBody } = makePoseTransforms(pose);

  const idx = end === "A" ? 0 : nodes.length - 1;
  const neighbourIdx = end === "A" ? 1 : nodes.length - 2;
  const epBody = nodes[idx].posMm;
  const outwardBody = endpointOutwardBody(nodes, end);
  // Where this end's optical face sits right now, in lab.
  const faceLab = bodyToLab([
    epBody[0] + outwardBody[0] * tipMm,
    epBody[1] + outwardBody[1] * tipMm,
    epBody[2] + outwardBody[2] * tipMm,
  ]);

  const oldNeighbour = nodes[neighbourIdx].posMm;
  const segLen = Math.hypot(
    oldNeighbour[0] - epBody[0],
    oldNeighbour[1] - epBody[1],
    oldNeighbour[2] - epBody[2],
  );
  const handleLen = Math.max(20, segLen * 0.33);

  const results: FiberAlignmentCandidate[] = [];
  for (const port of ports) {
    const distMm = Math.hypot(
      port.labPosMm[0] - faceLab[0],
      port.labPosMm[1] - faceLab[1],
      port.labPosMm[2] - faceLab[2],
    );
    if (distMm > toleranceMm) continue;

    const m = Math.hypot(port.labAxisX[0], port.labAxisX[1], port.labAxisX[2]);
    if (m < 1e-9) continue;
    // Same rule as `resolveLinkedFiberEndpoint` — see the long note there.
    // An optical anchor's axisX is the PROPAGATION direction, not a
    // mechanical outward normal, so End A faces back up it and End B along
    // it, exactly as the beam-align path does.
    const sign = end === "A" ? -1 : 1;
    const newOutwardLab: Vec3Tuple = [
      (sign * port.labAxisX[0]) / m,
      (sign * port.labAxisX[1]) / m,
      (sign * port.labAxisX[2]) / m,
    ];
    const newOutwardBody = rotateLabDirToBody(newOutwardLab);
    const portBody = labToBody(port.labPosMm);
    const backOff = tipMm + FIBER_MATING_GAP_MM;
    const newPosMmBody: Vec3Tuple = [
      portBody[0] - newOutwardBody[0] * backOff,
      portBody[1] - newOutwardBody[1] * backOff,
      portBody[2] - newOutwardBody[2] * backOff,
    ];
    // The handle points INTO the cable body (opposite the outward), same
    // convention `endpointOutwardBody` reads back out.
    const newHandleMmBody: Vec3Tuple = [
      -newOutwardBody[0] * handleLen,
      -newOutwardBody[1] * handleLen,
      -newOutwardBody[2] * handleLen,
    ];

    results.push({
      beamId: `port:${port.targetObjectId}:${port.targetAnchorId}`,
      distMm,
      projectedPortLab: port.labPosMm,
      newPosMmBody,
      newHandleMmBody,
      newOutwardBody,
      displayLabel: `🔌 ${port.targetName} · ${port.targetAnchorName}`,
      port: {
        targetObjectId: port.targetObjectId,
        targetAnchorId: port.targetAnchorId,
        targetAnchorName: port.targetAnchorName,
      },
    });
  }
  results.sort((a, b) => a.distMm - b.distMm);
  return results;
}

/** Read the current optical-port pose in LAB frame for one end of a fiber.
 *  Returns the ferrule-tip position (= node + outward·TIP, body→lab) and
 *  the outward unit vector in lab. Returns null when the spline is too
 *  short or undefined.
 *
 *  Used by the Object panel's per-end port-pose editor: lets the user see
 *  WHERE the port actually sits in world coords + which way it faces
 *  without doing the body↔lab transform in their head. */
export function getFiberPortLabPose(
  end: "A" | "B",
  nodes: FiberNodePersist[],
  pose: FiberAlignPose,
): { posLab: Vec3Tuple; outwardLab: Vec3Tuple } | null {
  if (!nodes || nodes.length < 2) return null;
  const idx = end === "A" ? 0 : nodes.length - 1;
  const outwardBody = endpointOutwardBody(nodes, end);
  const node = nodes[idx];
  const portBody: Vec3Tuple = [
    node.posMm[0] + outwardBody[0] * FIBER_FERRULE_TIP_MM,
    node.posMm[1] + outwardBody[1] * FIBER_FERRULE_TIP_MM,
    node.posMm[2] + outwardBody[2] * FIBER_FERRULE_TIP_MM,
  ];
  const { bodyToLab, rotateBodyDirToLab } = makePoseTransforms(pose);
  return { posLab: bodyToLab(portBody), outwardLab: rotateBodyDirToLab(outwardBody) };
}

/** Write a target optical-port pose in LAB frame for one end of a fiber.
 *  Returns a fresh `nodes` array with the touched endpoint's node + handle
 *  back-derived from the desired port lab pose:
 *
 *    outward_body = labDirToBody(targetOutwardLab)
 *    node_body    = labToBody(targetPosLab) − outward_body · FIBER_FERRULE_TIP_MM
 *    handle_body  = −outward_body · |prev_handle|   (or fallback length)
 *
 *  The handle MAGNITUDE is preserved from the previous handle when
 *  present (so the existing tension/bend stays intact), or falls back to
 *  max(20 mm, segment_length·0.33). Interior nodes don't move; only the
 *  endpoint and its outward-facing handle change. Caller is responsible
 *  for pushing the result through `updateFiberNodes`.
 *
 *  Note: `targetOutwardLab` is normalised before use; the caller can pass
 *  a non-unit vector. If the magnitude is below 1e-9 the function returns
 *  `nodes` unchanged. */
export function withFiberPortLabPose(opts: {
  end: "A" | "B";
  nodes: FiberNodePersist[];
  pose: FiberAlignPose;
  targetPosLab: Vec3Tuple;
  targetOutwardLab: Vec3Tuple;
}): FiberNodePersist[] {
  const { end, nodes, pose, targetPosLab, targetOutwardLab } = opts;
  if (!nodes || nodes.length < 2) return nodes;
  const outwardMag = Math.hypot(
    targetOutwardLab[0],
    targetOutwardLab[1],
    targetOutwardLab[2],
  );
  if (outwardMag < 1e-9) return nodes;
  const outwardLab: Vec3Tuple = [
    targetOutwardLab[0] / outwardMag,
    targetOutwardLab[1] / outwardMag,
    targetOutwardLab[2] / outwardMag,
  ];
  const idx = end === "A" ? 0 : nodes.length - 1;
  const neighbourIdx = end === "A" ? 1 : nodes.length - 2;
  const { labToBody, rotateLabDirToBody } = makePoseTransforms(pose);
  const outwardBody = rotateLabDirToBody(outwardLab);
  const portBody = labToBody(targetPosLab);
  const newPosBody: Vec3Tuple = [
    portBody[0] - outwardBody[0] * FIBER_FERRULE_TIP_MM,
    portBody[1] - outwardBody[1] * FIBER_FERRULE_TIP_MM,
    portBody[2] - outwardBody[2] * FIBER_FERRULE_TIP_MM,
  ];

  // Preserve handle magnitude when the existing handle is non-zero.
  const oldHandle = end === "A" ? nodes[idx].handleOutMm : nodes[idx].handleInMm;
  let handleLen: number;
  if (
    oldHandle &&
    oldHandle[0] ** 2 + oldHandle[1] ** 2 + oldHandle[2] ** 2 > 1e-9
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
  const newHandle: Vec3Tuple = [
    -outwardBody[0] * handleLen,
    -outwardBody[1] * handleLen,
    -outwardBody[2] * handleLen,
  ];

  const newNode: FiberNodePersist = {
    posMm: newPosBody,
    handleInMm:
      end === "B"
        ? newHandle
        : nodes[idx].handleInMm
          ? ([...nodes[idx].handleInMm] as Vec3Tuple)
          : undefined,
    handleOutMm:
      end === "A"
        ? newHandle
        : nodes[idx].handleOutMm
          ? ([...nodes[idx].handleOutMm] as Vec3Tuple)
          : undefined,
  };
  const nextNodes = [...nodes];
  nextNodes[idx] = newNode;
  return nextNodes;
}
