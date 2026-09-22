"""Pigtail-END align maths — a port of ``frontend/src/utils/pigtailAlignment.ts``
(and the two ``utils/portConnectorPlacement.ts`` helpers it stands on,
``basisOf`` / ``poseToMatrix``).

A pigtailed instrument (the EOSpace EOM is the first) does not align as one
body: its port IS the ``fiber_connector`` bound at it
(``binding.properties.portAnchor``), and ``db_scene_loader._port_connector_anchors``
re-seats the device's ``intercept_in`` / ``intercept_out`` onto that
connector's mating face. So aligning an end moves the CONNECTOR — solving
``outer · local · connect_in = target`` for the binding's local pose, with a
shortest-arc rotation so the PM key (``connect_in.axisY``) is not re-keyed —
and the box stays where it was bolted down.

Three frames meet here and must not be swapped: the connector asset's own
frame (the anchor), the Component frame (binding poses — plain XYZ Euler on
column vectors, ``poseToMatrix``), and lab (the SceneObject pose — the
transposed convention ``optical/pose.sceneObjectLabRotationMatrix``, the same
matrix as ``app.optical.pose._rotation_of``).

The TS does this with three.js ``Matrix4`` / ``Euler`` / ``Quaternion``; the
decomposition back to Euler is branchy (the ``|m13| < 0.9999999`` gimbal test)
and the shortest arc special-cases anti-parallel vectors, so the three.js
routines are transcribed here from ``node_modules/three/src/math`` (r170)
rather than re-derived — see ``app/optical/align/ts_compat.py`` for the same
policy. Matrices are three.js ``elements`` arrays (16 floats, COLUMN-major).
"""

from __future__ import annotations

import math
from typing import Any

from app.optical.align.ts_compat import (
    DEG2RAD,
    RAD2DEG,
    V,
    Quat,
    m4_rotation_elements,
    q_from_rotation_matrix,
    q_from_unit_vectors,
    v3_length,
    v3_length_sq,
    v3_normalize,
    v_cross,
)
from app.optical.fibers.geometry import (
    FIBER_MATING_GAP_MM,
    beam_candidate_meta,
    js_str,
    port_display_label,
    port_link,
)

M4 = list[float]
# A ComponentBinding pose in the TS ``BindingPose`` field names.
BindingPose = dict[str, float]
POSE_KEYS = ("localXMm", "localYMm", "localZMm", "localRxDeg", "localRyDeg", "localRzDeg")


# ─── THREE.Matrix4 (column-major ``elements``) ─────────────────────────────

def m4_identity() -> M4:
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def m4_set(*n: float) -> M4:
    """``Matrix4.set(n11, n12, …, n44)`` — arguments row-major."""
    return [
        n[0], n[4], n[8], n[12],
        n[1], n[5], n[9], n[13],
        n[2], n[6], n[10], n[14],
        n[3], n[7], n[11], n[15],
    ]


def m4_multiply(ae: M4, be: M4) -> M4:
    """``new Matrix4().multiplyMatrices(a, b)`` (= ``a.multiply(b)``)."""
    a11, a12, a13, a14 = ae[0], ae[4], ae[8], ae[12]
    a21, a22, a23, a24 = ae[1], ae[5], ae[9], ae[13]
    a31, a32, a33, a34 = ae[2], ae[6], ae[10], ae[14]
    a41, a42, a43, a44 = ae[3], ae[7], ae[11], ae[15]
    b11, b12, b13, b14 = be[0], be[4], be[8], be[12]
    b21, b22, b23, b24 = be[1], be[5], be[9], be[13]
    b31, b32, b33, b34 = be[2], be[6], be[10], be[14]
    b41, b42, b43, b44 = be[3], be[7], be[11], be[15]
    te = [0.0] * 16
    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44
    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44
    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44
    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44
    return te


def m4_determinant(te: M4) -> float:
    n11, n12, n13, n14 = te[0], te[4], te[8], te[12]
    n21, n22, n23, n24 = te[1], te[5], te[9], te[13]
    n31, n32, n33, n34 = te[2], te[6], te[10], te[14]
    n41, n42, n43, n44 = te[3], te[7], te[11], te[15]
    return (
        n41 * (
            + n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33
            + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34
        )
        + n42 * (
            + n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33
            - n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31
        )
        + n43 * (
            + n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32
            + n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31
        )
        + n44 * (
            - n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33
            + n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31
        )
    )


def m4_invert(te: M4) -> M4:
    """``Matrix4.invert`` (cofactors; the zero matrix when singular)."""
    n11, n21, n31, n41 = te[0], te[1], te[2], te[3]
    n12, n22, n32, n42 = te[4], te[5], te[6], te[7]
    n13, n23, n33, n43 = te[8], te[9], te[10], te[11]
    n14, n24, n34, n44 = te[12], te[13], te[14], te[15]
    t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44
    t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44
    t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44
    t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34
    det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14
    if det == 0:
        return [0.0] * 16
    d = 1 / det
    out = [0.0] * 16
    out[0] = t11 * d
    out[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d
    out[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d
    out[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d
    out[4] = t12 * d
    out[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d
    out[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d
    out[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d
    out[8] = t13 * d
    out[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d
    out[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d
    out[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d
    out[12] = t14 * d
    out[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d
    out[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d
    out[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d
    return out


def m4_set_position(te: M4, x: float, y: float, z: float) -> M4:
    out = list(te)
    out[12], out[13], out[14] = x, y, z
    return out


def m4_column(te: M4, i: int) -> V:
    """``Vector3.setFromMatrixColumn(m, i)``."""
    return V(te[i * 4], te[i * 4 + 1], te[i * 4 + 2])


def m4_position(te: M4) -> V:
    """``Vector3.setFromMatrixPosition(m)``."""
    return V(te[12], te[13], te[14])


def m4_extract_rotation(me: M4) -> M4:
    """``new Matrix4().extractRotation(m)``: the columns rescaled to unit
    length, translation dropped."""
    sx = 1 / v3_length(m4_column(me, 0))
    sy = 1 / v3_length(m4_column(me, 1))
    sz = 1 / v3_length(m4_column(me, 2))
    return [
        me[0] * sx, me[1] * sx, me[2] * sx, 0.0,
        me[4] * sy, me[5] * sy, me[6] * sy, 0.0,
        me[8] * sz, me[9] * sz, me[10] * sz, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]


def m4_make_basis(x: V, y: V, z: V) -> M4:
    return m4_set(
        x.x, y.x, z.x, 0.0,
        x.y, y.y, z.y, 0.0,
        x.z, y.z, z.z, 0.0,
        0.0, 0.0, 0.0, 1.0,
    )


def m4_rotation_from_euler_xyz(x: float, y: float, z: float) -> M4:
    """``makeRotationFromEuler(new Euler(x, y, z, "XYZ"))``."""
    a, b = math.cos(x), math.sin(x)
    c, d = math.cos(y), math.sin(y)
    e, f = math.cos(z), math.sin(z)
    ae, af, be, bf = a * e, a * f, b * e, b * f
    te = m4_identity()
    te[0] = c * e
    te[4] = -c * f
    te[8] = d
    te[1] = af + be * d
    te[5] = ae - bf * d
    te[9] = -b * c
    te[2] = bf - ae * d
    te[6] = be + af * d
    te[10] = a * c
    return te


def v3_apply_matrix4(v: V, e: M4) -> V:
    """``Vector3.applyMatrix4`` (with the projective divide)."""
    w = 1 / (e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15])
    return V(
        (e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12]) * w,
        (e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13]) * w,
        (e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14]) * w,
    )


def _q_from_matrix(te: M4) -> Quat:
    return q_from_rotation_matrix(
        te[0], te[4], te[8],
        te[1], te[5], te[9],
        te[2], te[6], te[10],
    )


def m4_decompose(te: M4) -> tuple[V, Quat]:
    """``Matrix4.decompose`` -> (position, quaternion); the scale is divided
    out as three.js does (a negative determinant flips X)."""
    sx = v3_length(V(te[0], te[1], te[2]))
    sy = v3_length(V(te[4], te[5], te[6]))
    sz = v3_length(V(te[8], te[9], te[10]))
    if m4_determinant(te) < 0:
        sx = -sx
    m1 = list(te)
    isx, isy, isz = 1 / sx, 1 / sy, 1 / sz
    m1[0] *= isx
    m1[1] *= isx
    m1[2] *= isx
    m1[4] *= isy
    m1[5] *= isy
    m1[6] *= isy
    m1[8] *= isz
    m1[9] *= isz
    m1[10] *= isz
    return V(te[12], te[13], te[14]), _q_from_matrix(m1)


def euler_xyz_from_matrix(te: M4) -> tuple[float, float, float]:
    """``Euler.setFromRotationMatrix(m, "XYZ")`` -> (x, y, z) in radians,
    including its ``|m13| < 0.9999999`` gimbal branch."""
    m11, m12, m13 = te[0], te[4], te[8]
    m22, m23 = te[5], te[9]
    m32, m33 = te[6], te[10]
    y = math.asin(max(-1.0, min(1.0, m13)))
    if abs(m13) < 0.9999999:
        return math.atan2(-m23, m33), y, math.atan2(-m12, m11)
    return math.atan2(m32, m22), y, 0.0


# ─── portConnectorPlacement helpers ────────────────────────────────────────

def _vec(raw: Any) -> V | None:
    """``portConnectorPlacement.vec``: an ``{x, y, z}`` of numbers with a finite
    squared length."""
    if not isinstance(raw, dict):
        return None
    xs = [raw.get("x"), raw.get("y"), raw.get("z")]
    if not all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in xs):
        return None
    out = V(float(xs[0]), float(xs[1]), float(xs[2]))
    return out if math.isfinite(v3_length_sq(out)) else None


def basis_of(anchor: dict) -> M4 | None:
    """``basisOf``: the anchor's orthonormal axis triad as a rotation matrix
    (axisX normalised, axisZ = X × Y, axisY re-squared as Z × X), or None when
    it has no usable axisX / axisY."""
    x = _vec(anchor.get("axisXBodyLocal"))
    y = _vec(anchor.get("axisYBodyLocal"))
    if x is None or y is None or v3_length_sq(x) < 1e-12 or v3_length_sq(y) < 1e-12:
        return None
    x = v3_normalize(x)
    z = v_cross(x, y)
    if v3_length_sq(z) < 1e-12:
        return None
    z = v3_normalize(z)
    y_ortho = v3_normalize(v_cross(z, x))
    return m4_make_basis(x, y_ortho, z)


def pose_to_matrix(pose: BindingPose) -> M4:
    """``poseToMatrix``: a binding pose as ``Euler(rx, ry, rz, "XYZ")`` +
    translation (the binding convention, NOT the SceneObject one)."""
    rot = m4_rotation_from_euler_xyz(
        pose["localRxDeg"] * DEG2RAD, pose["localRyDeg"] * DEG2RAD, pose["localRzDeg"] * DEG2RAD,
    )
    return m4_set_position(rot, pose["localXMm"], pose["localYMm"], pose["localZMm"])


def scene_object_matrix(pose: dict) -> M4:
    """``objectMatrix``: ``sceneObjectLabRotationMatrix(pose).setPosition(x, y, z)``
    — the SceneObject body->lab matrix (``pose._rotation_of``'s matrix)."""
    alpha = pose["rxDeg"] * math.pi / 180
    beta = pose["ryDeg"] * math.pi / 180
    gamma = pose["rzDeg"] * math.pi / 180
    ca, sa = math.cos(alpha), math.sin(alpha)
    cb, sb = math.cos(beta), math.sin(beta)
    cg, sg = math.cos(gamma), math.sin(gamma)
    rot = m4_set(
        cb * cg, sa * sb * cg + ca * sg, -ca * sb * cg + sa * sg, 0.0,
        -cb * sg, -sa * sb * sg + ca * cg, ca * sb * sg + sa * cg, 0.0,
        sb, -sa * cb, ca * cb, 0.0,
        0.0, 0.0, 0.0, 1.0,
    )
    return m4_set_position(rot, pose["xMm"], pose["yMm"], pose["zMm"])


# ─── pigtailAlignment.ts ───────────────────────────────────────────────────
#
# A "placement" is the TS ``ConnectorPlacement``: {"pose": BindingPose (the
# EFFECTIVE local pose, baseline + ObjectBinding delta), "parentPose":
# BindingPose | None (the parent chain composed), "connectIn": anchor dict}.

def _outer_matrix(placement: dict, object_pose: dict) -> M4:
    outer = scene_object_matrix(object_pose)
    parent = placement.get("parentPose")
    return m4_multiply(outer, pose_to_matrix(parent)) if parent else outer


def _anchor_matrix(anchor: dict) -> M4 | None:
    basis = basis_of(anchor)
    if basis is None:
        return None
    raw = anchor.get("positionMmBodyLocal")
    p = raw if isinstance(raw, dict) else {}

    def coord(key: str) -> float:  # `p?.x ?? 0`
        v = p.get(key)
        return 0.0 if v is None else v

    return m4_set_position(basis, coord("x"), coord("y"), coord("z"))


def _connector_frame_lab(placement: dict, object_pose: dict) -> M4 | None:
    anchor = _anchor_matrix(placement["connectIn"])
    if anchor is None:
        return None
    return m4_multiply(
        m4_multiply(_outer_matrix(placement, object_pose), pose_to_matrix(placement["pose"])),
        anchor,
    )


def connector_port_lab(placement: dict, object_pose: dict) -> dict | None:
    """``connectorPortLab``: the connector face's lab position + propagation
    direction right now (``{"posMm", "axisXMm"}``), None without an axis triad."""
    frame = _connector_frame_lab(placement, object_pose)
    if frame is None:
        return None
    return {
        "posMm": list(m4_position(frame)),
        "axisXMm": list(v3_normalize(m4_column(frame, 0))),
    }


def binding_pose_from_matrix(m: M4) -> BindingPose:
    """``bindingPoseFromMatrix``: decompose, then ``Euler.setFromQuaternion(q,
    "XYZ")`` (which goes back through ``makeRotationFromQuaternion``)."""
    pos, quat = m4_decompose(m)
    ex, ey, ez = euler_xyz_from_matrix(m4_rotation_elements(quat))
    return {
        "localXMm": pos.x,
        "localYMm": pos.y,
        "localZMm": pos.z,
        "localRxDeg": ex * RAD2DEG,
        "localRyDeg": ey * RAD2DEG,
        "localRzDeg": ez * RAD2DEG,
    }


def compute_connector_align_pose(
    *, placement: dict, object_pose: dict, target_pos_lab: list, target_axis_x_lab: list,
) -> BindingPose | None:
    """``computeConnectorAlignPose``: the connector binding's new EFFECTIVE
    local pose so its face lands on ``target_pos_lab`` looking along
    ``target_axis_x_lab`` — the shortest arc from where it looks now, so the
    roll (the PM key) is carried over."""
    anchor = _anchor_matrix(placement["connectIn"])
    current = _connector_frame_lab(placement, object_pose)
    if anchor is None or current is None:
        return None
    want = V(*target_axis_x_lab)
    if not v3_length_sq(want) > 1e-12:
        return None
    want = v3_normalize(want)
    current_axis_x = v3_normalize(m4_column(current, 0))
    fix = q_from_unit_vectors(current_axis_x, want)
    target = m4_set_position(
        m4_multiply(m4_rotation_elements(fix), m4_extract_rotation(current)),
        target_pos_lab[0], target_pos_lab[1], target_pos_lab[2],
    )
    local = m4_multiply(
        m4_multiply(m4_invert(_outer_matrix(placement, object_pose)), target),
        m4_invert(anchor),
    )
    return binding_pose_from_matrix(local)


def compose_binding_poses(poses: list[BindingPose]) -> BindingPose | None:
    """``composeBindingPoses``: a parent->child chain flattened into one pose
    (None for the empty chain — a root binding)."""
    if not poses:
        return None
    m = m4_identity()
    for pose in poses:
        m = m4_multiply(m, pose_to_matrix(pose))
    return binding_pose_from_matrix(m)


def wrap_deg(deg: float) -> float:
    """``wrapDeg`` to (−180, 180], with JS ``%`` (truncated) semantics."""
    wrapped = math.fmod(math.fmod(deg + 180, 360) + 360, 360) - 180
    return 180.0 if wrapped == -180 else wrapped


def binding_pose_delta(target: BindingPose, baseline: BindingPose) -> dict[str, float]:
    """``bindingPoseDelta``: the per-axis ``ObjectBinding`` delta turning
    ``baseline`` into ``target`` (angles wrapped)."""
    return {
        "localXMmDelta": target["localXMm"] - baseline["localXMm"],
        "localYMmDelta": target["localYMm"] - baseline["localYMm"],
        "localZMmDelta": target["localZMm"] - baseline["localZMm"],
        "localRxDegDelta": wrap_deg(target["localRxDeg"] - baseline["localRxDeg"]),
        "localRyDegDelta": wrap_deg(target["localRyDeg"] - baseline["localRyDeg"]),
        "localRzDegDelta": wrap_deg(target["localRzDeg"] - baseline["localRzDeg"]),
    }


def pigtail_nodes_following_connector(
    *, nodes: list[dict], old_pose: BindingPose, new_pose: BindingPose, connect_out_pos_mm: list,
) -> list[dict]:
    """``pigtailNodesFollowingConnector``: re-weld the run's LAST node to the
    moved connector's cable root and carry its ``handleInMm`` through the
    same rotation; node 0 and the interior stay where the user dressed them."""
    if len(nodes) < 2:
        return list(nodes)
    old_m = pose_to_matrix(old_pose)
    new_m = pose_to_matrix(new_pose)
    delta_rot = m4_multiply(
        m4_extract_rotation(new_m), m4_invert(m4_extract_rotation(old_m)),
    )
    last = nodes[-1]
    pos = v3_apply_matrix4(V(*connect_out_pos_mm), new_m)
    node = dict(last)
    node["posMm"] = list(pos)
    handle_in = last.get("handleInMm")
    if isinstance(handle_in, list) and len(handle_in) == 3:
        node["handleInMm"] = list(v3_apply_matrix4(V(*handle_in), delta_rot))
    out = list(nodes)
    out[-1] = node
    return out


def find_pigtail_beam_candidates(
    *, port_lab: dict, beam_segments: list[dict], tolerance_mm: float | None,
) -> list[dict]:
    """``findPigtailBeamCandidates``: beams within ``tolerance_mm`` of the
    face, closest first; the face lands on its projection and takes the
    segment's propagation direction. ``None`` skips the distance filter."""
    face = V(*port_lab["posMm"])
    out: list[dict] = []
    for seg in beam_segments:
        a = V(*seg["aMm"])
        b = V(*seg["bMm"])
        ab = V(b.x - a.x, b.y - a.y, b.z - a.z)
        len_sq = v3_length_sq(ab)
        if len_sq < 1e-6:
            continue
        fa = V(face.x - a.x, face.y - a.y, face.z - a.z)
        t = max(0.0, min(1.0, (fa.x * ab.x + fa.y * ab.y + fa.z * ab.z) / len_sq))
        projected = V(a.x + ab.x * t, a.y + ab.y * t, a.z + ab.z * t)
        dx, dy, dz = projected.x - face.x, projected.y - face.y, projected.z - face.z
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        if tolerance_mm is not None and dist > tolerance_mm:
            continue
        out.append(beam_candidate_meta(seg, {
            "key": seg.get("beamId"),
            "distMm": dist,
            "targetPosLab": list(projected),
            "targetAxisXLab": list(v3_normalize(ab)),
        }))
    out.sort(key=lambda c: c["distMm"])
    return out


def mated_face_lab(port: dict, end: str) -> dict | None:
    """``matedFaceLab``: where a pigtail end's face lands in ``port`` — on the
    port's axis, one mating gap DOWNSTREAM for End A (light leaves the
    receptacle and enters us) and upstream for End B."""
    axis = V(*port["labAxisX"])
    if not v3_length_sq(axis) > 1e-12:
        return None
    axis = v3_normalize(axis)
    s = (1 if end == "A" else -1) * FIBER_MATING_GAP_MM
    p = port["labPosMm"]
    return {
        "targetPosLab": [p[0] + axis.x * s, p[1] + axis.y * s, p[2] + axis.z * s],
        "targetAxisXLab": list(axis),
    }


def find_pigtail_port_candidates(
    *, end: str, port_lab: dict, ports: list[dict], tolerance_mm: float | None,
) -> list[dict]:
    """``findPigtailPortCandidates``: receptacles within ``tolerance_mm`` of
    the face, closest first, each mated by :func:`mated_face_lab`."""
    face = port_lab["posMm"]
    out: list[dict] = []
    for port in ports:
        p = port["labPosMm"]
        dx, dy, dz = p[0] - face[0], p[1] - face[1], p[2] - face[2]
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        if tolerance_mm is not None and dist > tolerance_mm:
            continue
        mated = mated_face_lab(port, end)
        if mated is None:
            continue
        out.append({
            "key": f"port:{port['targetObjectId']}:{port['targetAnchorId']}",
            "distMm": dist,
            **mated,
            "displayLabel": port_display_label(port),
            "port": port_link(port),
        })
    out.sort(key=lambda c: c["distMm"])
    return out


def dedup_pigtail_candidates(candidates: list[dict]) -> list[dict]:
    """``findPigtailAlignmentCandidates``' dedup: a port keeps its own key, a
    beam collapses onto its chain (emitter, AOM order, branch)."""
    by_key: dict[str, dict] = {}
    for c in candidates:
        if c.get("port"):
            key = str(c["key"])
        else:
            emitter, order, branch = c.get("emitterObjectId"), c.get("aomOrder"), c.get("branch")
            key = (
                f"{'?' if emitter is None else js_str(emitter)}"
                f":o{'x' if order is None else js_str(order)}"
                f":{'' if branch is None else js_str(branch)}"
            )
        prev = by_key.get(key)
        if prev is None or c["distMm"] < prev["distMm"]:
            by_key[key] = c
    return sorted(by_key.values(), key=lambda c: c["distMm"])
