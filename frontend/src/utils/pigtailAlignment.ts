/**
 * Align ONE PIGTAIL END of a fibre-coupled instrument — the EOSpace EOM is
 * the first — onto a beam, or into another part's fibre receptacle.
 *
 * The fiber patch cable's `Align End A/B` moves a SPLINE ENDPOINT, because
 * for a cable the endpoint IS the optical port. A pigtailed instrument is
 * built the other way round: the box is rigid, the port is the
 * `fiber_connector` bound at it (`binding.properties.portAnchor`), and the
 * backend's `db_scene_loader._port_connector_anchors` re-seats
 * intercept_in / intercept_out onto that connector's `connect_in`. So
 * "align this end" means MOVE THAT CONNECTOR, and the port follows for
 * free — the box never moves.
 *
 * Where the move is persisted: the connector's ComponentBinding pose is the
 * catalog baseline shared by every instance of the part, so the align writes
 * an `ObjectBinding` per-axis DELTA instead (`effective = baseline + delta`,
 * the same composition `componentBindings._effectiveTransform` and the
 * backend's `_binding_pose_with_override` both do). The pigtail spline is
 * dragged along by {@link pigtailNodesFollowingConnector} — its last node is
 * welded to the connector's `connect_out`, per
 * `DigitalTwinViewer`'s pigtail node-edit gizmo.
 *
 * Frames, and why there are three of them:
 *   - the connector's `connect_in` lives in the CONNECTOR ASSET's frame;
 *   - the binding pose puts that asset in the COMPONENT frame (plain XYZ
 *     Euler on column vectors — `portConnectorPlacement.poseToMatrix`);
 *   - the SceneObject pose lifts the Component frame to LAB (the transposed
 *     YXZ convention in `optical/pose`, NOT the binding one).
 * Mixing the two rotation conventions is the classic way to get angles that
 * look plausible and are wrong, so both are taken from their existing
 * modules rather than re-derived here.
 *
 * Rotation choice: the connector is rotated by the SHORTEST ARC that takes
 * its current `connect_in` axisX onto the target direction, applied on top
 * of its current orientation. That keeps the roll — and `connect_in.axisY`
 * is the PM slow-axis key the loader hands the device as the polarization it
 * accepts, so a gratuitous spin would silently re-key the modulator.
 */
import * as THREE from "three";

import { sceneObjectLabRotationMatrix, type V3Pose } from "../optical/pose";
import {
  basisOf,
  poseToMatrix,
  type AnchorFrameLike,
  type BindingPose,
  type PigtailNode,
} from "./portConnectorPlacement";
import { FIBER_MATING_GAP_MM } from "./fiberAnchorResolver";
import type {
  BeamSegmentLab,
  FiberPortLab,
  FiberPortLink,
  Vec3Tuple,
} from "./fiberAlignment";

/** End A is the input port's connector, End B the output port's. Which
 *  anchor each one dresses — the key `binding.properties.portAnchor` holds. */
export const PIGTAIL_END_PORT_ANCHOR: Record<"A" | "B", string> = {
  A: "intercept_in",
  B: "intercept_out",
};

/** Everything the align math needs about ONE port connector, already
 *  resolved out of the scene by the caller. */
export type ConnectorPlacement = {
  /** Effective local pose = ComponentBinding baseline + ObjectBinding delta. */
  pose: BindingPose;
  /** Composed pose of the binding's PARENT chain in the Component frame,
   *  or null when the connector binding is a root (the EOM case). */
  parentPose: BindingPose | null;
  /** `connect_in` — the ferrule end face — in the connector asset's frame. */
  connectIn: AnchorFrameLike;
};

/** Where a port connector's optical face currently sits, in lab mm.
 *  `axisXMm` is the PROPAGATION direction (anchors.md), not a mechanical
 *  outward normal. */
export type PigtailPortLab = { posMm: Vec3Tuple; axisXMm: Vec3Tuple };

/** One entry in the End A / End B picker. Unlike the fiber's candidate this
 *  carries only the LAB-frame target — turning that into a binding pose is
 *  {@link computeConnectorAlignPose}'s job, and it needs the placement the
 *  store resolves at apply time anyway. */
export type PigtailAlignmentCandidate = {
  /** Stable identity for dedup + React keys. `trace:…` or `port:…`. */
  key: string;
  /** How far the face is from the target right now (mm). Ranks the picker. */
  distMm: number;
  /** Where the face should land. */
  targetPosLab: Vec3Tuple;
  /** Propagation direction the face should carry once aligned. */
  targetAxisXLab: Vec3Tuple;
  displayLabel?: string;
  emitterObjectId?: string;
  aomOrder?: number | null;
  branch?: string;
  wavelengthNm?: number;
  /** Present only on receptacle candidates — what the store persists as
   *  `SceneObject.properties.pigtailEndpoints[portAnchor]` so the end
   *  FOLLOWS that part. A beam candidate has none and clears any link. */
  port?: FiberPortLink;
};

const asTuple = (v: THREE.Vector3): Vec3Tuple => [v.x, v.y, v.z];

/** SceneObject pose as a body→lab matrix (transposed-YXZ convention). */
function objectMatrix(pose: V3Pose): THREE.Matrix4 {
  return sceneObjectLabRotationMatrix(pose).setPosition(
    pose.xMm,
    pose.yMm,
    pose.zMm,
  );
}

/** Component frame → lab, INCLUDING the connector binding's parent chain but
 *  NOT the connector binding itself — i.e. the part of the transform the
 *  align may not touch. */
function outerMatrix(placement: ConnectorPlacement, objectPose: V3Pose): THREE.Matrix4 {
  const outer = objectMatrix(objectPose);
  return placement.parentPose
    ? outer.multiply(poseToMatrix(placement.parentPose))
    : outer;
}

/** `connect_in`'s own frame within the connector asset, or null when the
 *  anchor carries no usable axis triad. */
function anchorMatrix(anchor: AnchorFrameLike): THREE.Matrix4 | null {
  const basis = basisOf(anchor);
  if (!basis) return null;
  const p = anchor.positionMmBodyLocal;
  return basis.setPosition(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
}

/** Full lab frame of the connector's optical face. */
function connectorFrameLab(
  placement: ConnectorPlacement,
  objectPose: V3Pose,
): THREE.Matrix4 | null {
  const anchor = anchorMatrix(placement.connectIn);
  if (!anchor) return null;
  return outerMatrix(placement, objectPose)
    .multiply(poseToMatrix(placement.pose))
    .multiply(anchor);
}

/** Lab position + propagation direction of a port connector's face right
 *  now. Returns null when `connect_in` has no axis triad to read. */
export function connectorPortLab(
  placement: ConnectorPlacement,
  objectPose: V3Pose,
): PigtailPortLab | null {
  const frame = connectorFrameLab(placement, objectPose);
  if (!frame) return null;
  return {
    posMm: asTuple(new THREE.Vector3().setFromMatrixPosition(frame)),
    axisXMm: asTuple(
      new THREE.Vector3().setFromMatrixColumn(frame, 0).normalize(),
    ),
  };
}

function bindingPoseFromMatrix(m: THREE.Matrix4): BindingPose {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  m.decompose(pos, quat, scale);
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  return {
    localXMm: pos.x,
    localYMm: pos.y,
    localZMm: pos.z,
    localRxDeg: THREE.MathUtils.radToDeg(euler.x),
    localRyDeg: THREE.MathUtils.radToDeg(euler.y),
    localRzDeg: THREE.MathUtils.radToDeg(euler.z),
  };
}

/**
 * The connector binding's new EFFECTIVE local pose so its `connect_in` lands
 * on `targetPosLab` with its axisX along `targetAxisXLab`.
 *
 * Solves `outer · local · anchor = target` for `local`, where `outer` is the
 * SceneObject pose composed with the binding's parent chain. Returns null
 * when `connect_in` has no axis triad or the target direction is degenerate.
 */
export function computeConnectorAlignPose(opts: {
  placement: ConnectorPlacement;
  objectPose: V3Pose;
  targetPosLab: Vec3Tuple;
  targetAxisXLab: Vec3Tuple;
}): BindingPose | null {
  const { placement, objectPose, targetPosLab, targetAxisXLab } = opts;
  const anchor = anchorMatrix(placement.connectIn);
  const current = connectorFrameLab(placement, objectPose);
  if (!anchor || !current) return null;

  const want = new THREE.Vector3(...targetAxisXLab);
  if (!(want.lengthSq() > 1e-12)) return null;
  want.normalize();

  // Shortest arc from where the face looks now to where it should look —
  // everything else about the connector's orientation is carried over.
  const currentAxisX = new THREE.Vector3().setFromMatrixColumn(current, 0).normalize();
  const fix = new THREE.Quaternion().setFromUnitVectors(currentAxisX, want);
  const target = new THREE.Matrix4()
    .makeRotationFromQuaternion(fix)
    .multiply(new THREE.Matrix4().extractRotation(current))
    .setPosition(targetPosLab[0], targetPosLab[1], targetPosLab[2]);

  const local = outerMatrix(placement, objectPose)
    .invert()
    .multiply(target)
    .multiply(anchor.invert());
  return bindingPoseFromMatrix(local);
}

/** Flatten a parent→child chain of binding poses into the single pose that
 *  composes to the same transform. Lets a connector nested under other
 *  bindings be aligned exactly like a root one. Returns null for an empty
 *  chain (the root case). */
export function composeBindingPoses(
  poses: readonly BindingPose[],
): BindingPose | null {
  if (poses.length === 0) return null;
  const m = new THREE.Matrix4();
  for (const pose of poses) m.multiply(poseToMatrix(pose));
  return bindingPoseFromMatrix(m);
}

/** Wrap to (−180, 180]. A delta shifted by a whole turn is the same
 *  rotation, so this only keeps the numbers the slider UI shows sane. */
function wrapDeg(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** Per-axis `ObjectBinding` delta that turns `baseline` into `target`. */
export function bindingPoseDelta(
  target: BindingPose,
  baseline: BindingPose,
): {
  localXMmDelta: number;
  localYMmDelta: number;
  localZMmDelta: number;
  localRxDegDelta: number;
  localRyDegDelta: number;
  localRzDegDelta: number;
} {
  return {
    localXMmDelta: target.localXMm - baseline.localXMm,
    localYMmDelta: target.localYMm - baseline.localYMm,
    localZMmDelta: target.localZMm - baseline.localZMm,
    localRxDegDelta: wrapDeg(target.localRxDeg - baseline.localRxDeg),
    localRyDegDelta: wrapDeg(target.localRyDeg - baseline.localRyDeg),
    localRzDegDelta: wrapDeg(target.localRzDeg - baseline.localRzDeg),
  };
}

/**
 * Re-dress the pigtail after its connector moved.
 *
 * The last node is welded to the connector's `connect_out` (the wire
 * junction at the back of the boot), so it is re-derived from the new pose;
 * its `handleIn` is carried over through the same rotation, which preserves
 * the authored angle the fibre leaves the boot at. Node 0 (the device's
 * fibre exit) and every interior node stay exactly where the user put them
 * — the run simply stretches, which is what the real fibre does.
 *
 * Returns `nodes` unchanged when there are fewer than two of them.
 */
export function pigtailNodesFollowingConnector(opts: {
  nodes: readonly PigtailNode[];
  oldPose: BindingPose;
  newPose: BindingPose;
  /** `connect_out` position in the connector asset's own frame. */
  connectOutPosMm: Vec3Tuple;
}): PigtailNode[] {
  const { nodes, oldPose, newPose, connectOutPosMm } = opts;
  if (nodes.length < 2) return [...nodes];
  const oldM = poseToMatrix(oldPose);
  const newM = poseToMatrix(newPose);
  const deltaRot = new THREE.Matrix4()
    .extractRotation(newM)
    .multiply(new THREE.Matrix4().extractRotation(oldM).invert());

  const last = nodes[nodes.length - 1];
  const posMm = asTuple(new THREE.Vector3(...connectOutPosMm).applyMatrix4(newM));
  const handleInMm = last.handleInMm
    ? asTuple(new THREE.Vector3(...last.handleInMm).applyMatrix4(deltaRot))
    : undefined;

  const next = [...nodes];
  next[next.length - 1] = {
    ...last,
    posMm,
    ...(handleInMm ? { handleInMm } : {}),
  };
  return next;
}

/** Beam segments within `toleranceMm` of the connector face, closest first.
 *  The face lands on its projection onto the segment and takes the segment's
 *  propagation direction (start → end). */
export function findPigtailBeamCandidates(opts: {
  portLab: PigtailPortLab;
  beamSegmentsLab: readonly BeamSegmentLab[];
  toleranceMm: number;
}): PigtailAlignmentCandidate[] {
  const { portLab, beamSegmentsLab, toleranceMm } = opts;
  const face = new THREE.Vector3(...portLab.posMm);
  const out: PigtailAlignmentCandidate[] = [];
  for (const seg of beamSegmentsLab) {
    const a = new THREE.Vector3(...seg.aMm);
    const ab = new THREE.Vector3(...seg.bMm).sub(a);
    const lenSq = ab.lengthSq();
    if (lenSq < 1e-6) continue;
    const t = Math.max(0, Math.min(1, face.clone().sub(a).dot(ab) / lenSq));
    const projected = a.clone().addScaledVector(ab, t);
    const distMm = projected.distanceTo(face);
    if (distMm > toleranceMm) continue;
    out.push({
      key: seg.beamId,
      distMm,
      targetPosLab: asTuple(projected),
      targetAxisXLab: asTuple(ab.clone().normalize()),
      displayLabel: seg.displayLabel,
      emitterObjectId: seg.emitterObjectId,
      aomOrder: seg.aomOrder ?? null,
      branch: seg.branch,
      wavelengthNm: seg.wavelengthNm,
    });
  }
  out.sort((x, y) => x.distMm - y.distMm);
  return out;
}

/** Where a pigtail end's face lands when plugged into `port`.
 *
 *  Both faces end up on the same optical axis a mating gap apart: End A sits
 *  just DOWNSTREAM of the receptacle (light leaves it and enters us), End B
 *  just upstream (we feed it). The gap is not cosmetic — a ray emitted
 *  exactly on the receiving plane is dropped by `nearest_anchor_hit`'s
 *  `t_min`, which is why `findFiberPortAlignmentCandidates` backs a patch
 *  cord off by the same amount. Returns null for a degenerate port axis. */
export function matedFaceLab(
  port: FiberPortLab,
  end: "A" | "B",
): { targetPosLab: Vec3Tuple; targetAxisXLab: Vec3Tuple } | null {
  const axis = new THREE.Vector3(...port.labAxisX);
  if (!(axis.lengthSq() > 1e-12)) return null;
  axis.normalize();
  return {
    targetPosLab: asTuple(
      new THREE.Vector3(...port.labPosMm).addScaledVector(
        axis,
        (end === "A" ? 1 : -1) * FIBER_MATING_GAP_MM,
      ),
    ),
    targetAxisXLab: asTuple(axis),
  };
}

/** Fibre receptacles within `toleranceMm` of the connector face, closest
 *  first — each mated by {@link matedFaceLab}. */
export function findPigtailPortCandidates(opts: {
  end: "A" | "B";
  portLab: PigtailPortLab;
  ports: readonly FiberPortLab[];
  toleranceMm: number;
}): PigtailAlignmentCandidate[] {
  const { end, portLab, ports, toleranceMm } = opts;
  const face = new THREE.Vector3(...portLab.posMm);
  const out: PigtailAlignmentCandidate[] = [];
  for (const port of ports) {
    const distMm = new THREE.Vector3(...port.labPosMm).distanceTo(face);
    if (distMm > toleranceMm) continue;
    const mated = matedFaceLab(port, end);
    if (!mated) continue;
    out.push({
      key: `port:${port.targetObjectId}:${port.targetAnchorId}`,
      distMm,
      ...mated,
      displayLabel: `🔌 ${port.targetName} · ${port.targetAnchorName}`,
      port: {
        targetObjectId: port.targetObjectId,
        targetAnchorId: port.targetAnchorId,
        targetAnchorName: port.targetAnchorName,
      },
    });
  }
  out.sort((x, y) => x.distMm - y.distMm);
  return out;
}
