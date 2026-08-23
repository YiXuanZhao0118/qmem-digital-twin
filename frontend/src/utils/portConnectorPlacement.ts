/**
 * Where to place a `fiber_connector` asset so it BECOMES a device's optical
 * port, without moving that port.
 *
 * A fibre-pigtailed instrument has no bare optical face — it has an FC/APC
 * bulkhead. The model for that (see docs/introduce/component.md) is a
 * `fiber_connector` binding tagged `properties.portAnchor = "intercept_in" |
 * "intercept_out"`; the backend's `db_scene_loader._port_connector_anchors`
 * then re-seats that named anchor of the sibling DEVICE asset onto the
 * connector's `connect_in` — position, `apertureMm`, and `axisY` (the PM
 * slow-axis key). So the connector binding, not the device asset, decides
 * where the port physically is.
 *
 * Which means a connector dropped in at the identity transform silently
 * DRAGS THE PORT with it: `pm_apc_780` carries its `connect_in` 59.3 mm up
 * its own body, so an un-posed binding would move the coupling face ~59 mm
 * off the device and every traced number with it. The zero-change default is
 * therefore "put `connect_in` exactly on the anchor it is replacing", which
 * is what this module computes. From there the user drags the connector out
 * to the end of a pigtail run; `_port_connector_anchors` carries the port
 * along, which is the whole point of the derivation.
 *
 * The frame rule (reverse-engineered from the hand-authored EOSpace
 * AZ-0S5-20-PFA-PFA-850/900 ports and pinned in
 * `__tests__/portConnectorPlacement.test.ts`, which reproduces both of its
 * bindings to 1e-9):
 *
 *     R = A_anchor · A_connect_in ᵀ        T = p_anchor − R · p_connect_in
 *
 * i.e. map the connector's whole `connect_in` frame onto the device anchor's
 * frame. Aligning axisX alone would leave the roll free, and that roll is not
 * cosmetic — `connect_in.axisY` IS the PM key the loader hands the device as
 * the polarization axis it accepts.
 *
 * Note the two axisX end up PARALLEL, not anti-parallel. `component.md`
 * describes the loader "sign-flipping the connector's mating normal to
 * agree", which reads like the authored geometry should oppose the anchor —
 * it does not; that flip is internal to the loader. Both real ports have
 * dot(axisX_connect_in, axisX_anchor) = +1.
 *
 * Rotations are the binding convention: a plain `THREE.Euler(rx, ry, rz,
 * "XYZ")` on column vectors, matching `ComponentsEditor.poseFromBinding` and
 * `three/bindingTreeObject`. This is NOT the SceneObject convention
 * (`optical/frames.sceneObjectEulerFromQuaternion`, which is transposed) —
 * reusing that one here yields wrong angles.
 */
import * as THREE from "three";

export type Vec3Like = { x: number; y: number; z: number };

export type AnchorFrameLike = {
  positionMmBodyLocal?: Vec3Like | null;
  axisXBodyLocal?: Vec3Like | null;
  axisYBodyLocal?: Vec3Like | null;
  axisZBodyLocal?: Vec3Like | null;
};

/** The six pose columns of a ComponentBinding row. */
export type BindingPose = {
  localXMm: number;
  localYMm: number;
  localZMm: number;
  localRxDeg: number;
  localRyDeg: number;
  localRzDeg: number;
};

function vec(v: Vec3Like | null | undefined): THREE.Vector3 | null {
  if (!v || typeof v.x !== "number" || typeof v.y !== "number" || typeof v.z !== "number") {
    return null;
  }
  const out = new THREE.Vector3(v.x, v.y, v.z);
  return Number.isFinite(out.lengthSq()) ? out : null;
}

/** Orthonormal basis matrix from an anchor's axis triad, or null if the
 *  anchor doesn't carry a usable one. axisZ is derived when absent; a
 *  non-orthogonal axisY is re-squared against axisX rather than trusted. */
export function basisOf(anchor: AnchorFrameLike): THREE.Matrix4 | null {
  const x = vec(anchor.axisXBodyLocal);
  const y = vec(anchor.axisYBodyLocal);
  if (!x || !y || x.lengthSq() < 1e-12 || y.lengthSq() < 1e-12) return null;
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  if (z.lengthSq() < 1e-12) return null; // axisY parallel to axisX — degenerate
  z.normalize();
  const yOrtho = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Matrix4().makeBasis(x, yOrtho, z);
}

export function poseToMatrix(pose: BindingPose): THREE.Matrix4 {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(pose.localRxDeg),
    THREE.MathUtils.degToRad(pose.localRyDeg),
    THREE.MathUtils.degToRad(pose.localRzDeg),
    "XYZ",
  );
  return new THREE.Matrix4().makeRotationFromEuler(euler).setPosition(
    pose.localXMm,
    pose.localYMm,
    pose.localZMm,
  );
}

/**
 * Pose for a `fiber_connector` binding that puts the connector's `connect_in`
 * exactly on `deviceAnchor` — the port keeps the position, direction and key
 * angle the device asset authored, so binding the connector changes no traced
 * number until the user moves it.
 *
 * `devicePose` is the DEVICE binding's own pose, since both bindings are
 * expressed in the same Component frame; pass null when the device sits at
 * the identity. Returns null when either anchor lacks a usable axis triad —
 * callers should fall back to the identity and say so rather than guess.
 */
export function computePortConnectorPose(
  deviceAnchor: AnchorFrameLike,
  connectorConnectIn: AnchorFrameLike,
  devicePose: BindingPose | null,
): BindingPose | null {
  const anchorBasis = basisOf(deviceAnchor);
  const connectorBasis = basisOf(connectorConnectIn);
  if (!anchorBasis || !connectorBasis) return null;

  const anchorPos = vec(deviceAnchor.positionMmBodyLocal) ?? new THREE.Vector3();
  const connectPos = vec(connectorConnectIn.positionMmBodyLocal) ?? new THREE.Vector3();

  // Lift the device anchor out of the device asset's body frame into the
  // Component frame the binding columns live in.
  let anchorInComponent = anchorBasis;
  const anchorPosInComponent = anchorPos.clone();
  if (devicePose) {
    const deviceMatrix = poseToMatrix(devicePose);
    anchorPosInComponent.applyMatrix4(deviceMatrix);
    const deviceRotation = new THREE.Matrix4().extractRotation(deviceMatrix);
    anchorInComponent = new THREE.Matrix4().multiplyMatrices(deviceRotation, anchorBasis);
  }

  // R maps the connector's connect_in frame onto the anchor's frame.
  const rotation = new THREE.Matrix4().multiplyMatrices(
    anchorInComponent,
    new THREE.Matrix4().copy(connectorBasis).transpose(),
  );
  const translation = anchorPosInComponent
    .clone()
    .sub(connectPos.clone().applyMatrix4(rotation));

  const euler = new THREE.Euler().setFromRotationMatrix(rotation, "XYZ");
  return {
    localXMm: translation.x,
    localYMm: translation.y,
    localZMm: translation.z,
    localRxDeg: THREE.MathUtils.radToDeg(euler.x),
    localRyDeg: THREE.MathUtils.radToDeg(euler.y),
    localRzDeg: THREE.MathUtils.radToDeg(euler.z),
  };
}

/** A pigtail spline node, structurally the `FiberNode` the renderer takes. */
export type PigtailNode = {
  posMm: [number, number, number];
  handleInMm?: [number, number, number];
  handleOutMm?: [number, number, number];
};

/**
 * Shape constants for a seeded pigtail, read back off the hand-authored
 * EOSpace jacket rather than invented (see the test). Both end handles are
 * the horizontal run direction tilted DOWN, and the middle node sags below
 * the chord — a strain-relief droop, which is what the real fibre does.
 */
const PIGTAIL_HANDLE_FRACTION = 0.306; // |handle| / span
const PIGTAIL_END_TILT_DEG = 30; // end handles, tilted toward −Z
const PIGTAIL_SAG_FRACTION = 0.174; // mid node drop below the chord / span
const PIGTAIL_MID_HANDLE_FRACTION = 0.133;
/** Below this the connector is a bulkhead sitting on the face, not a pigtail. */
const PIGTAIL_MIN_SPAN_MM = 5;

/**
 * A default jacket for a port: the run of fibre between where it leaves the
 * device body and the back of the connector.
 *
 * Both arguments are in the **parent (Component) frame**, which is the frame
 * `bindingTreeObject.buildBindingPigtail` reads `properties.fiberNodes` in —
 * it hangs the tube on the parent group, NOT on the binding's pivot, so
 * applying the binding transform to these would double-count it.
 *
 * Endpoints are structural and the node-edit gizmo locks them: node 0 is
 * welded to the device's fibre exit (the port anchor) and the last node to
 * the connector's `connect_out`. Only their handles, and the middle node,
 * are meant to be dragged.
 *
 * "Down" is the Component frame's −Z. That is right for a bench part sitting
 * on a table (the frame is Z-up) and is only a starting shape regardless —
 * returns a straight 2-node run when the span is vertical enough that a
 * horizontal direction can't be recovered, and null when the connector is
 * close enough to the anchor to be a plain bulkhead.
 */
export function buildPigtailNodes(
  exitPosMm: readonly [number, number, number],
  connectOutPosMm: readonly [number, number, number],
): PigtailNode[] | null {
  const n0 = new THREE.Vector3(...exitPosMm);
  const n2 = new THREE.Vector3(...connectOutPosMm);
  const chord = new THREE.Vector3().subVectors(n2, n0);
  const span = chord.length();
  if (!Number.isFinite(span) || span < PIGTAIL_MIN_SPAN_MM) return null;

  const asTuple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];
  const horizontal = new THREE.Vector3(chord.x, chord.y, 0);
  if (horizontal.lengthSq() < 1e-9) {
    // A purely vertical run — no meaningful "down" to sag toward.
    return [
      { posMm: asTuple(n0), handleOutMm: asTuple(chord.clone().multiplyScalar(0.3)) },
      { posMm: asTuple(n2), handleInMm: asTuple(chord.clone().multiplyScalar(-0.3)) },
    ];
  }
  horizontal.normalize();

  const tilt = THREE.MathUtils.degToRad(PIGTAIL_END_TILT_DEG);
  const handleLength = span * PIGTAIL_HANDLE_FRACTION;
  const tilted = (towards: THREE.Vector3): THREE.Vector3 =>
    towards
      .clone()
      .multiplyScalar(Math.cos(tilt))
      .add(new THREE.Vector3(0, 0, -Math.sin(tilt)))
      .normalize()
      .multiplyScalar(handleLength);

  const mid = new THREE.Vector3()
    .addVectors(n0, n2)
    .multiplyScalar(0.5)
    .add(new THREE.Vector3(0, 0, -span * PIGTAIL_SAG_FRACTION));
  const midHandle = horizontal.clone().multiplyScalar(span * PIGTAIL_MID_HANDLE_FRACTION);

  return [
    { posMm: asTuple(n0), handleOutMm: asTuple(tilted(horizontal)) },
    {
      posMm: asTuple(mid),
      handleInMm: asTuple(midHandle.clone().negate()),
      handleOutMm: asTuple(midHandle),
    },
    { posMm: asTuple(n2), handleInMm: asTuple(tilted(horizontal.clone().negate())) },
  ];
}

/** An asset anchor's position expressed in the Component frame, given the
 *  pose of the binding that places that asset. */
export function anchorPositionInComponentFrame(
  anchor: AnchorFrameLike,
  bindingPose: BindingPose | null,
): [number, number, number] {
  const p = vec(anchor.positionMmBodyLocal) ?? new THREE.Vector3();
  if (bindingPose) p.applyMatrix4(poseToMatrix(bindingPose));
  return [p.x, p.y, p.z];
}
