from __future__ import annotations

import math
import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.models import Asset3D, AssemblyRelation, Component, SceneObject


Vec = dict[str, float]
AXES = ("x", "y", "z")
POSITION_FIELDS = {"x": "x_mm", "y": "y_mm", "z": "z_mm"}
ROTATION_FIELDS = {"x": "rx_deg", "y": "ry_deg", "z": "rz_deg"}
POSITION_RELATIONS = {"same_position", "offset_position", "distance", "face_touch", "face_offset", "face_align_center"}
ROTATION_RELATIONS = {
    "same_direction",
    "opposite_direction",
    "perpendicular_direction",
    "face_parallel",
    "look_at",
}
LOCK_RELATIONS = {"lock_transform"}
UNIMPLEMENTED_RELATIONS = {"concentric", "tangent", "angle"}
TYPE_ALIASES = {
    "face_distance": "face_offset",
    "coincident": "face_touch",
    "parallel": "face_parallel",
    "perpendicular": "perpendicular_direction",
    "align_axis": "same_direction",
}


def vec(x: float = 0, y: float = 0, z: float = 0) -> Vec:
    return {"x": float(x), "y": float(y), "z": float(z)}


def read_vec(value: object, fallback: Vec | None = None) -> Vec:
    if isinstance(value, dict):
        return vec(
            value.get("x", fallback["x"] if fallback else 0),
            value.get("y", fallback["y"] if fallback else 0),
            value.get("z", fallback["z"] if fallback else 0),
        )
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return vec(value[0], value[1], value[2])
    return fallback.copy() if fallback else vec()


def add(left: Vec, right: Vec) -> Vec:
    return {axis: left[axis] + right[axis] for axis in AXES}


def sub(left: Vec, right: Vec) -> Vec:
    return {axis: left[axis] - right[axis] for axis in AXES}


def mul(value: Vec, scale: float) -> Vec:
    return {axis: value[axis] * scale for axis in AXES}


def dot(left: Vec, right: Vec) -> float:
    return sum(left[axis] * right[axis] for axis in AXES)


def length(value: Vec) -> float:
    return math.sqrt(dot(value, value))


def normalize(value: Vec) -> Vec | None:
    size = length(value)
    if size == 0:
        return None
    return mul(value, 1 / size)


def rotate_vec(value: Vec, rx_deg: float, ry_deg: float, rz_deg: float) -> Vec:
    # Lab-frame rotation: R = Rz(rz) · Rx(rx) · Ry(ry). Mirrors the YXZ-intrinsic
    # Euler order applied by the Three.js renderer (frontend transformUtils.ts).
    rx = math.radians(rx_deg)
    ry = math.radians(ry_deg)
    rz = math.radians(rz_deg)

    cy, sy = math.cos(ry), math.sin(ry)
    x1 = value["x"] * cy + value["z"] * sy
    y1 = value["y"]
    z1 = -value["x"] * sy + value["z"] * cy

    cx, sx = math.cos(rx), math.sin(rx)
    x2 = x1
    y2 = y1 * cx - z1 * sx
    z2 = y1 * sx + z1 * cx

    cz, sz = math.cos(rz), math.sin(rz)
    return vec(
        x2 * cz - y2 * sz,
        x2 * sz + y2 * cz,
        z2,
    )


def cross(a: Vec, b: Vec) -> Vec:
    return vec(
        a["y"] * b["z"] - a["z"] * b["y"],
        a["z"] * b["x"] - a["x"] * b["z"],
        a["x"] * b["y"] - a["y"] * b["x"],
    )


# --- 3×3 matrix helpers (lab-frame Rz · Rx · Ry to match the renderer) ---------
# Matrices are stored as 3-element tuples of 3-element tuples (row-major).

Matrix = tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]

IDENTITY_MATRIX: Matrix = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))


def matmul(a: Matrix, b: Matrix) -> Matrix:
    return tuple(
        tuple(sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3))
        for i in range(3)
    )  # type: ignore[return-value]


def mat_apply(m: Matrix, v: Vec) -> Vec:
    return vec(
        m[0][0] * v["x"] + m[0][1] * v["y"] + m[0][2] * v["z"],
        m[1][0] * v["x"] + m[1][1] * v["y"] + m[1][2] * v["z"],
        m[2][0] * v["x"] + m[2][1] * v["y"] + m[2][2] * v["z"],
    )


def matrix_from_euler(rx_deg: float, ry_deg: float, rz_deg: float) -> Matrix:
    """Build R = Rz(rz) · Rx(rx) · Ry(ry) — same convention as ``rotate_vec``."""

    rx = math.radians(rx_deg)
    ry = math.radians(ry_deg)
    rz = math.radians(rz_deg)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    return (
        (cz * cy - sz * sx * sy, -sz * cx, cz * sy + sz * sx * cy),
        (sz * cy + cz * sx * sy, cz * cx, sz * sy - cz * sx * cy),
        (-cx * sy, sx, cx * cy),
    )


def euler_from_matrix(m: Matrix) -> tuple[float, float, float]:
    """Inverse of ``matrix_from_euler``: returns (rx, ry, rz) in degrees.

    Decomposes ``R = Rz(rz) · Rx(rx) · Ry(ry)`` where ``sin(rx) = R[2][1]``.
    Handles the gimbal-lock case ``rx = ±90°`` by collapsing ry into rz.
    """

    sx = max(-1.0, min(1.0, m[2][1]))
    rx = math.asin(sx)
    cx = math.sqrt(max(0.0, 1.0 - sx * sx))
    if cx > 1e-7:
        ry = math.atan2(-m[2][0], m[2][2])
        rz = math.atan2(-m[0][1], m[1][1])
    else:
        # Gimbal lock: cos(rx) = 0 ⇒ Ry and Rz axes coincide.
        ry = 0.0
        rz = math.atan2(m[1][0], m[0][0])
    return math.degrees(rx), math.degrees(ry), math.degrees(rz)


def axis_angle_matrix(axis: Vec, angle_rad: float) -> Matrix:
    """Rodrigues' rotation formula: rotation matrix around unit ``axis`` by ``angle_rad``."""

    a = normalize(axis)
    if a is None:
        return IDENTITY_MATRIX
    x, y, z = a["x"], a["y"], a["z"]
    c = math.cos(angle_rad)
    s = math.sin(angle_rad)
    t = 1.0 - c
    return (
        (t * x * x + c, t * x * y - s * z, t * x * z + s * y),
        (t * x * y + s * z, t * y * y + c, t * y * z - s * x),
        (t * x * z - s * y, t * y * z + s * x, t * z * z + c),
    )


def rotation_aligning(source: Vec, target: Vec) -> Matrix:
    """Smallest rotation matrix that maps unit ``source`` onto unit ``target``.

    For nearly antiparallel inputs we deterministically pick a perpendicular
    axis so the result is reproducible across solver runs.
    """

    a = normalize(source)
    b = normalize(target)
    if a is None or b is None:
        return IDENTITY_MATRIX
    cos_theta = max(-1.0, min(1.0, dot(a, b)))
    if cos_theta > 1.0 - 1e-9:
        return IDENTITY_MATRIX
    if cos_theta < -1.0 + 1e-9:
        # Antiparallel: pick the world axis least aligned with `a` to build a
        # perpendicular, then rotate 180° around it.
        helper = vec(1, 0, 0) if abs(a["x"]) < 0.9 else vec(0, 1, 0)
        axis = normalize(cross(a, helper)) or vec(0, 0, 1)
        return axis_angle_matrix(axis, math.pi)
    axis = normalize(cross(a, b)) or vec(0, 0, 1)
    return axis_angle_matrix(axis, math.acos(cos_theta))


def perpendicular_unit_vector(reference: Vec, hint: Vec | None = None) -> Vec:
    """Return a unit vector perpendicular to ``reference``.

    If ``hint`` is non-degenerate, returns the projection of ``hint`` onto the
    plane perpendicular to ``reference``. Otherwise picks an axis-aligned
    perpendicular deterministically.
    """

    ref = normalize(reference) or vec(1, 0, 0)
    if hint is not None:
        proj = sub(hint, mul(ref, dot(hint, ref)))
        normalized = normalize(proj)
        if normalized is not None:
            return normalized
    helper = vec(1, 0, 0) if abs(ref["x"]) < 0.9 else vec(0, 1, 0)
    return normalize(cross(ref, helper)) or vec(0, 0, 1)


def object_position(placement: SceneObject) -> Vec:
    return vec(placement.x_mm, placement.y_mm, placement.z_mm)


def object_rotation(placement: SceneObject) -> tuple[float, float, float]:
    return (
        float(placement.rx_deg or 0.0),
        float(placement.ry_deg or 0.0),
        float(placement.rz_deg or 0.0),
    )


def object_size(placement: SceneObject, component: Component | None) -> Vec:
    properties = placement.properties if isinstance(placement.properties, dict) else {}
    size = read_vec(properties.get("size"), fallback=None)
    if any(size[axis] for axis in AXES):
        return size

    component_properties = component.properties if component and isinstance(component.properties, dict) else {}
    dimensions = component_properties.get("dimensionsMm")
    if isinstance(dimensions, (list, tuple)) and len(dimensions) == 3:
        return read_vec(dimensions)
    if isinstance(dimensions, dict):
        return read_vec(dimensions)
    return vec(100, 100, 100)

def normalize_anchor_id(anchor_id: str | None) -> str:
    if not anchor_id:
        return "center"

    value = str(anchor_id).strip().lower()

    aliases = {
        "center": "center",
        "centre": "center",

        "+x": "+x",
        "x+": "+x",
        "+x face": "+x",
        "+xface": "+x",
        "positive x": "+x",
        "right": "+x",

        "-x": "-x",
        "x-": "-x",
        "-x face": "-x",
        "-xface": "-x",
        "negative x": "-x",
        "left": "-x",

        "+y": "+y",
        "y+": "+y",
        "+y face": "+y",
        "+yface": "+y",
        "positive y": "+y",
        "top": "+y",

        "-y": "-y",
        "y-": "-y",
        "-y face": "-y",
        "-yface": "-y",
        "negative y": "-y",
        "bottom": "-y",

        "+z": "+z",
        "z+": "+z",
        "+z face": "+z",
        "+zface": "+z",
        "positive z": "+z",
        "front": "+z",

        "-z": "-z",
        "z-": "-z",
        "-z face": "-z",
        "-zface": "-z",
        "negative z": "-z",
        "back": "-z",
    }

    return aliases.get(value, value)


def _anchor_position_local(anchor: dict[str, object]) -> object | None:
    """Phase 4 unification: prefer the new `positionMmBodyLocal` key,
    fall back to legacy `localPosition` for transitional cases (e.g.
    in-process dicts not yet normalised by alembic 0018)."""
    return anchor.get("positionMmBodyLocal") or anchor.get("localPosition")


def _anchor_direction_local(anchor: dict[str, object]) -> object | None:
    """Phase 4 unification: prefer the new `directionBodyLocal` key,
    fall back to legacy `localDirection` for transitional cases."""
    return anchor.get("directionBodyLocal") or anchor.get("localDirection")


def standard_anchor(anchor_id: str, size: Vec) -> dict[str, object] | None:
    half = {axis: size[axis] / 2 for axis in AXES}
    # Phase 4 (2026-05-07): emit the new frame/unit-suffixed field names
    # so ad-hoc readers stay consistent with what alembic 0018 wrote into
    # JSONB. The reader helpers above accept both names during the
    # transition.
    anchors: dict[str, dict[str, object]] = {
        "center": {"id": "center", "name": "Center", "type": "center", "positionMmBodyLocal": vec()},
        "+x": {"id": "+x", "name": "+X face", "type": "face", "positionMmBodyLocal": vec(half["x"], 0, 0), "directionBodyLocal": vec(1, 0, 0)},
        "-x": {"id": "-x", "name": "-X face", "type": "face", "positionMmBodyLocal": vec(-half["x"], 0, 0), "directionBodyLocal": vec(-1, 0, 0)},
        "+y": {"id": "+y", "name": "+Y face", "type": "face", "positionMmBodyLocal": vec(0, half["y"], 0), "directionBodyLocal": vec(0, 1, 0)},
        "-y": {"id": "-y", "name": "-Y face", "type": "face", "positionMmBodyLocal": vec(0, -half["y"], 0), "directionBodyLocal": vec(0, -1, 0)},
        "+z": {"id": "+z", "name": "+Z face", "type": "face", "positionMmBodyLocal": vec(0, 0, half["z"]), "directionBodyLocal": vec(0, 0, 1)},
        "-z": {"id": "-z", "name": "-Z face", "type": "face", "positionMmBodyLocal": vec(0, 0, -half["z"]), "directionBodyLocal": vec(0, 0, -1)},
    }
    normalized_id = normalize_anchor_id(anchor_id)
    return anchors.get(normalized_id)

async def component_for(session: AsyncSession, placement: SceneObject) -> Component | None:
    if session is None:
        return None
    return await session.get(Component, placement.component_id)


async def asset_for(session: AsyncSession, component: Component | None) -> Asset3D | None:
    if session is None or component is None or component.asset_3d_id is None:
        return None
    return await session.get(Asset3D, component.asset_3d_id)


def find_anchor_in_list(anchors: object, anchor_id: str) -> dict[str, object] | None:
    if not isinstance(anchors, list):
        return None
    for anchor in anchors:
        if isinstance(anchor, dict) and normalize_anchor_id(anchor.get("id")) == anchor_id:
            return anchor
    return None


async def anchor_for(session: AsyncSession, placement: SceneObject, anchor_id: str | None) -> dict[str, object]:
    # Resolution order: placement override → asset default → standard box anchor.
    anchor_id = normalize_anchor_id(anchor_id)
    properties = placement.properties if isinstance(placement.properties, dict) else {}

    placement_match = find_anchor_in_list(properties.get("anchors"), anchor_id)
    if placement_match is not None:
        return placement_match

    component = await component_for(session, placement)
    asset = await asset_for(session, component)
    if asset is not None:
        asset_match = find_anchor_in_list(asset.anchors, anchor_id)
        if asset_match is not None:
            return asset_match

    return standard_anchor(anchor_id, object_size(placement, component)) or standard_anchor("center", vec(100, 100, 100))


async def world_anchor_position(session: AsyncSession, placement: SceneObject, anchor_id: str | None) -> Vec:
    anchor = await anchor_for(session, placement, anchor_id)
    local_position = read_vec(_anchor_position_local(anchor))
    rotated = rotate_vec(local_position, *object_rotation(placement))
    return add(object_position(placement), rotated)


async def world_anchor_direction(session: AsyncSession, placement: SceneObject, anchor_id: str | None) -> Vec | None:
    anchor = await anchor_for(session, placement, anchor_id)
    direction = read_vec(_anchor_direction_local(anchor), fallback=None)
    if not any(direction[axis] for axis in AXES):
        selector_normal = anchor.get("normal")
        if selector_normal is None:
            return None
        direction = read_vec(selector_normal)
    rotated = rotate_vec(direction, *object_rotation(placement))
    return normalize(rotated)


def target_from_relation(relation: AssemblyRelation, key: str) -> dict[str, Any]:
    properties = relation.properties if isinstance(relation.properties, dict) else {}
    target = properties.get(key)

    if key == "a":
        selector = relation.selector_a
        fallback_object_id = str(relation.object_a_id)
    else:
        selector = relation.selector_b
        fallback_object_id = str(relation.object_b_id)

    if isinstance(target, dict):
        object_id = target.get("objectId") or target.get("object_id") or fallback_object_id
        anchor_id = (
            target.get("anchorId")
            or target.get("anchor_id")
            or target.get("id")
            or target.get("name")
        )

        return {
            "objectId": str(object_id),
            "anchorId": normalize_anchor_id(anchor_id),
        }

    anchor_id = None
    if isinstance(selector, dict):
        anchor_id = (
            selector.get("anchorId")
            or selector.get("anchor_id")
            or selector.get("id")
            or selector.get("name")
        )

    return {
        "objectId": fallback_object_id,
        "anchorId": normalize_anchor_id(anchor_id),
    }
    
    
def relation_params(relation: AssemblyRelation) -> dict[str, Any]:
    properties = relation.properties if isinstance(relation.properties, dict) else {}
    params = properties.get("params")
    return params if isinstance(params, dict) else {}


def relation_priority(relation: AssemblyRelation) -> int:
    properties = relation.properties if isinstance(relation.properties, dict) else {}
    value = properties.get("priority", 0)
    return int(value) if isinstance(value, (int, float)) else 0


def driven_object_id(relation: AssemblyRelation) -> str:
    properties = relation.properties if isinstance(relation.properties, dict) else {}
    value = properties.get("drivenObjectId")
    return str(value) if value else str(relation.object_b_id)


def driver_object_id(relation: AssemblyRelation) -> str:
    properties = relation.properties if isinstance(relation.properties, dict) else {}
    value = properties.get("driverObjectId")
    return str(value) if value else str(relation.object_a_id)


def normalized_relation_type(relation: AssemblyRelation) -> str:
    return TYPE_ALIASES.get(relation.relation_type, relation.relation_type)


def lock_state(placement: SceneObject) -> dict[str, dict[str, bool]]:
    if placement.locked:
        return {
            "position": {"x": True, "y": True, "z": True},
            "rotation": {"x": True, "y": True, "z": True},
        }
    properties = placement.properties if isinstance(placement.properties, dict) else {}
    locked = properties.get("locked")
    if not isinstance(locked, dict):
        return {
            "position": {"x": False, "y": False, "z": False},
            "rotation": {"x": False, "y": False, "z": False},
        }
    return {
        "position": {
            axis: bool((locked.get("position") or {}).get(axis, False))
            for axis in AXES
        },
        "rotation": {
            axis: bool((locked.get("rotation") or {}).get(axis, False))
            for axis in AXES
        },
    }


def set_position_with_locks(placement: SceneObject, next_position: Vec) -> bool:
    locked = lock_state(placement)["position"]
    changed = False
    for axis, field in POSITION_FIELDS.items():
        current = float(getattr(placement, field))
        target = next_position[axis]
        if locked[axis] and abs(current - target) > 1e-6:
            return False
        if not locked[axis] and abs(current - target) > 1e-6:
            setattr(placement, field, target)
            changed = True
    return changed or True


def set_rotation_with_locks(
    placement: SceneObject, next_rotation: tuple[float, float, float]
) -> bool:
    """Apply ``next_rotation`` (rx, ry, rz in degrees) to ``placement`` while
    respecting per-axis rotation locks.

    Returns False (rejecting the move entirely) when any locked axis would have
    to change. Returns True even when nothing actually moves so callers can mark
    the relation solved when the rotation already matches the target.
    """

    locked = lock_state(placement)["rotation"]
    targets = dict(zip(("x", "y", "z"), next_rotation, strict=True))
    for axis, field in ROTATION_FIELDS.items():
        current = float(getattr(placement, field) or 0.0)
        target = targets[axis]
        if locked[axis] and abs((current - target + 180.0) % 360.0 - 180.0) > 1e-6:
            return False
    for axis, field in ROTATION_FIELDS.items():
        target = targets[axis]
        if not locked[axis]:
            setattr(placement, field, float(target))
    return True


def rotate_driven_to_world_direction(
    driven: SceneObject,
    driven_local_direction: Vec,
    driven_anchor_world_direction: Vec,
    target_world_direction: Vec,
) -> tuple[float, float, float] | None:
    """Compose a rotation that aligns ``driven``'s anchor world direction onto
    ``target_world_direction`` and decompose back to YXZ Euler angles.

    Implementation: ``R_align`` = rotation taking ``driven_anchor_world_direction``
    to ``target_world_direction`` (Rodrigues). New rotation matrix is
    ``R_new = R_align · R_current`` so that ``R_new · driven_local_direction``
    == ``target_world_direction``. Returns None if any input is degenerate.
    """

    if normalize(driven_local_direction) is None:
        return None
    if normalize(driven_anchor_world_direction) is None:
        return None
    if normalize(target_world_direction) is None:
        return None
    r_current = matrix_from_euler(*object_rotation(driven))
    r_align = rotation_aligning(driven_anchor_world_direction, target_world_direction)
    r_new = matmul(r_align, r_current)
    return euler_from_matrix(r_new)


def mark_relation(relation: AssemblyRelation, solved: bool, message: str | None = None) -> None:
    relation.solved = solved
    properties = dict(relation.properties) if isinstance(relation.properties, dict) else {}
    if message:
        properties["solveMessage"] = message
    else:
        properties.pop("solveMessage", None)
    relation.properties = properties
    flag_modified(relation, "properties")


def mark_controlled_by(placement: SceneObject, relation: AssemblyRelation) -> None:
    properties = dict(placement.properties) if isinstance(placement.properties, dict) else {}
    controlled_by = properties.get("controlledBy")
    if not isinstance(controlled_by, dict):
        controlled_by = {}
    position = controlled_by.get("position")
    if not isinstance(position, list):
        position = []
    relation_id = str(relation.id)
    if relation_id not in position:
        position.append(relation_id)
    controlled_by["position"] = position
    properties["controlledBy"] = controlled_by
    properties["transformMode"] = "constrained"
    placement.properties = properties
    flag_modified(placement, "properties")


def relation_edge(relation: AssemblyRelation) -> tuple[str, str]:
    return driver_object_id(relation), driven_object_id(relation)


async def relation_creates_cycle(session: AsyncSession, candidate: AssemblyRelation) -> bool:
    candidate_driver, candidate_driven = relation_edge(candidate)
    relations = await session.scalars(select(AssemblyRelation).where(AssemblyRelation.enabled.is_(True)))
    graph: dict[str, set[str]] = {}
    for relation in relations:
        if candidate.id is not None and relation.id == candidate.id:
            continue
        driver, driven = relation_edge(relation)
        graph.setdefault(driver, set()).add(driven)
    graph.setdefault(candidate_driver, set()).add(candidate_driven)

    seen: set[str] = set()
    stack = [candidate_driven]
    while stack:
        current = stack.pop()
        if current == candidate_driver:
            return True
        if current in seen:
            continue
        seen.add(current)
        stack.extend(graph.get(current, set()))
    return False


async def solve_relation(session: AsyncSession, relation: AssemblyRelation) -> SceneObject | None:
    if relation.enabled is False:
        mark_relation(relation, False, "Relation is disabled.")
        return None

    target_a = target_from_relation(relation, "a")
    target_b = target_from_relation(relation, "b")
    driven_id = driven_object_id(relation)
    driver_target = target_b if str(target_b.get("objectId")) != driven_id else target_a
    driven_target = target_a if str(target_a.get("objectId")) == driven_id else target_b

    try:
        driver_pk = uuid.UUID(str(driver_target.get("objectId")))
        driven_pk = uuid.UUID(str(driven_target.get("objectId")))
    except ValueError:
        mark_relation(relation, False, "Relation target object IDs are invalid.")
        return None

    driver = await session.get(SceneObject, driver_pk)
    driven = await session.get(SceneObject, driven_pk)
    if driver is None or driven is None:
        mark_relation(relation, False, "Relation references a missing object.")
        return None
    if any(lock_state(driven)["position"].values()) and driven.locked:
        mark_relation(relation, False, "Driven object is locked.")
        return None

    relation_type = normalized_relation_type(relation)
    driver_anchor = await world_anchor_position(session, driver, driver_target.get("anchorId"))
    driven_anchor = await world_anchor_position(session, driven, driven_target.get("anchorId"))
    driven_position = object_position(driven)
    anchor_delta = sub(driven_anchor, driven_position)
    params = relation_params(relation)

    if relation_type in {"same_position", "face_touch"}:
        next_position = sub(driver_anchor, anchor_delta)
    elif relation_type == "offset_position":
        # Center-to-center offset: driven_center = driver_center + offset.
        # The selectors only describe which faces face each other (UI / visualization);
        # the offset is the literal vector between the two object centers, so the
        # user's intuition "DBR.x + offset.x = laser.x" holds.
        offset = read_vec(params.get("offset"), fallback=None)
        if not any(offset[axis] for axis in AXES) and relation.offset_mm is not None:
            direction = await world_anchor_direction(session, driver, driver_target.get("anchorId"))
            offset = mul(direction or vec(0, 1, 0), relation.offset_mm)
        next_position = add(object_position(driver), offset)
    elif relation_type == "face_offset":
        # Face-to-face offset: separates the two anchor faces by `offset` in world space.
        offset = read_vec(params.get("offset"), fallback=None)
        if not any(offset[axis] for axis in AXES) and relation.offset_mm is not None:
            direction = await world_anchor_direction(session, driver, driver_target.get("anchorId"))
            offset = mul(direction or vec(0, 1, 0), relation.offset_mm)
        next_position = sub(add(driver_anchor, offset), anchor_delta)
    elif relation_type == "distance":
        distance = float(params.get("distance", relation.offset_mm or 0))
        direction = await world_anchor_direction(session, driver, driver_target.get("anchorId"))
        next_position = sub(add(driver_anchor, mul(direction or vec(0, 1, 0), distance)), anchor_delta)
    elif relation_type == "face_align_center":
        next_anchor = driven_anchor.copy()
        driver_direction = await world_anchor_direction(session, driver, driver_target.get("anchorId"))
        normal = driver_direction or vec(0, 1, 0)
        locked_axis = max(AXES, key=lambda axis: abs(normal[axis]))
        for axis in AXES:
            if axis != locked_axis:
                next_anchor[axis] = driver_anchor[axis]
        next_position = sub(next_anchor, anchor_delta)
    elif relation_type in ROTATION_RELATIONS:
        return await solve_rotation_relation(
            session, relation, driver, driven, driver_target, driven_target
        )
    elif relation_type == "lock_transform":
        return solve_lock_transform_relation(relation, driver, driven)
    elif relation_type in UNIMPLEMENTED_RELATIONS:
        mark_relation(
            relation,
            False,
            f"Relation type '{relation_type}' is recognised but the solver does not yet handle it (axis/edge anchors required).",
        )
        return None
    else:
        mark_relation(relation, False, f"Unsupported relation type: {relation_type}.")
        return None

    if not set_position_with_locks(driven, next_position):
        mark_relation(relation, False, "Driven object has locked position axes.")
        return None

    if relation_type in POSITION_RELATIONS:
        mark_controlled_by(driven, relation)
    mark_relation(relation, True)
    return driven


async def solve_rotation_relation(
    session: AsyncSession,
    relation: AssemblyRelation,
    driver: SceneObject,
    driven: SceneObject,
    driver_target: dict[str, Any],
    driven_target: dict[str, Any],
) -> SceneObject | None:
    """Active rotation solver for direction relations.

    Computes the target world direction the driven anchor should point along
    (depends on the relation type), then composes the smallest rotation onto the
    driven object's current rotation that achieves it. Returns the driven
    object so the calling cascade can re-pin downstream position relations
    against the post-rotation anchor positions.
    """

    relation_type = normalized_relation_type(relation)
    driven_world_direction = await world_anchor_direction(
        session, driven, driven_target.get("anchorId")
    )
    driven_anchor_descriptor = await anchor_for(session, driven, driven_target.get("anchorId"))
    driven_local_direction = read_vec(
        _anchor_direction_local(driven_anchor_descriptor), fallback=None
    )
    if not any(driven_local_direction[axis] for axis in AXES):
        normal = driven_anchor_descriptor.get("normal")
        if isinstance(normal, (list, tuple, dict)):
            driven_local_direction = read_vec(normal)

    if driven_world_direction is None or normalize(driven_local_direction) is None:
        mark_relation(
            relation,
            False,
            f"Direction relation '{relation_type}' needs the driven anchor to declare a non-zero directionBodyLocal or normal.",
        )
        return None

    needs_driver_direction = relation_type != "look_at"
    driver_world_direction: Vec | None = None
    if needs_driver_direction:
        driver_world_direction = await world_anchor_direction(
            session, driver, driver_target.get("anchorId")
        )
        if driver_world_direction is None:
            mark_relation(
                relation,
                False,
                f"Direction relation '{relation_type}' needs the driver anchor to declare a non-zero directionBodyLocal or normal.",
            )
            return None

    if relation_type in {"same_direction", "face_parallel"}:
        assert driver_world_direction is not None  # guarded above
        target_world_direction = driver_world_direction
    elif relation_type == "opposite_direction":
        assert driver_world_direction is not None
        target_world_direction = mul(driver_world_direction, -1.0)
    elif relation_type == "perpendicular_direction":
        assert driver_world_direction is not None
        target_world_direction = perpendicular_unit_vector(
            driver_world_direction, driven_world_direction
        )
    elif relation_type == "look_at":
        # Aim the driven anchor along the line from the driven *center* toward
        # the driver anchor world position. Using the driven center as the
        # pivot makes this a fixed-point problem (rotation does not move the
        # center), so a single solve converges even when the anchor is offset
        # from the center.
        driver_anchor_pos = await world_anchor_position(
            session, driver, driver_target.get("anchorId")
        )
        diff = sub(driver_anchor_pos, object_position(driven))
        normalized_diff = normalize(diff)
        if normalized_diff is None:
            mark_relation(
                relation,
                False,
                "look_at: driver anchor coincides with driven center; cannot derive a direction.",
            )
            return None
        target_world_direction = normalized_diff
    else:  # pragma: no cover - guarded by ROTATION_RELATIONS membership
        mark_relation(relation, False, f"Unhandled rotation relation: {relation_type}.")
        return None

    next_rotation = rotate_driven_to_world_direction(
        driven,
        driven_local_direction,
        driven_world_direction,
        target_world_direction,
    )
    if next_rotation is None:
        mark_relation(relation, False, "Direction relation could not derive a rotation (degenerate inputs).")
        return None

    if not set_rotation_with_locks(driven, next_rotation):
        mark_relation(relation, False, "Driven object has locked rotation axes.")
        return None

    mark_relation(relation, True)
    return driven


def solve_lock_transform_relation(
    relation: AssemblyRelation,
    driver: SceneObject,
    driven: SceneObject,
) -> SceneObject | None:
    """Maintain a rigid relative pose between driver and driven.

    On first solve, captures the current ``driver→driven`` delta into the
    relation's ``properties.lockedTransform``. Every subsequent solve forces
    driven to satisfy ``driven_pose = driver_pose ∘ delta`` so the pair behaves
    as a rigid body.
    """

    properties = dict(relation.properties) if isinstance(relation.properties, dict) else {}
    lock = properties.get("lockedTransform")

    driver_position = object_position(driver)
    driver_rot = matrix_from_euler(*object_rotation(driver))
    driver_rot_inverse = (
        (driver_rot[0][0], driver_rot[1][0], driver_rot[2][0]),
        (driver_rot[0][1], driver_rot[1][1], driver_rot[2][1]),
        (driver_rot[0][2], driver_rot[1][2], driver_rot[2][2]),
    )

    if not isinstance(lock, dict):
        # Capture: store the current relative pose in driver's local frame.
        driven_position = object_position(driven)
        delta_world = sub(driven_position, driver_position)
        delta_local = mat_apply(driver_rot_inverse, delta_world)
        driven_rot_local = matmul(driver_rot_inverse, matrix_from_euler(*object_rotation(driven)))
        properties["lockedTransform"] = {
            "deltaLocal": {axis: delta_local[axis] for axis in AXES},
            "rotationLocal": [list(row) for row in driven_rot_local],
        }
        relation.properties = properties
        flag_modified(relation, "properties")
        mark_relation(relation, True)
        return None

    delta_local = read_vec(lock.get("deltaLocal"))
    rotation_local_raw = lock.get("rotationLocal")
    if not (
        isinstance(rotation_local_raw, list)
        and len(rotation_local_raw) == 3
        and all(isinstance(row, list) and len(row) == 3 for row in rotation_local_raw)
    ):
        mark_relation(relation, False, "lock_transform: stored rotation is malformed; recreate the relation to recapture.")
        return None
    driven_rot_local: Matrix = tuple(tuple(float(v) for v in row) for row in rotation_local_raw)  # type: ignore[assignment]

    delta_world = mat_apply(driver_rot, delta_local)
    next_position = add(driver_position, delta_world)
    next_rotation_matrix = matmul(driver_rot, driven_rot_local)
    next_rotation = euler_from_matrix(next_rotation_matrix)

    if not set_position_with_locks(driven, next_position):
        mark_relation(relation, False, "lock_transform: driven object has locked position axes.")
        return None
    if not set_rotation_with_locks(driven, next_rotation):
        mark_relation(relation, False, "lock_transform: driven object has locked rotation axes.")
        return None

    mark_controlled_by(driven, relation)
    mark_relation(relation, True)
    return driven


def _relation_pass_key(relation: AssemblyRelation) -> int:
    """Pass ordering: rotation/lock first (0), then position (1).

    Rotating the driven changes the world position of every anchor on it, so
    the position pass must read post-rotation anchor positions. Lock-transform
    sets both, so it shares the rotation pass.
    """

    relation_type = normalized_relation_type(relation)
    if relation_type in ROTATION_RELATIONS or relation_type in LOCK_RELATIONS:
        return 0
    return 1


async def _solve_relations_for(
    session: AsyncSession,
    placement: SceneObject,
    visited: set[str],
    controlled_positions: set[str],
    solved_relations: set[str],
) -> list[SceneObject]:
    relations = await session.scalars(
        select(AssemblyRelation)
        .where(
            AssemblyRelation.enabled.is_(True),
            or_(
                AssemblyRelation.object_a_id == placement.id,
                AssemblyRelation.object_b_id == placement.id,
            ),
        )
        .order_by(AssemblyRelation.created_at)
    )
    ordered = sorted(
        list(relations),
        key=lambda r: (_relation_pass_key(r), -relation_priority(r)),
    )
    changed: list[SceneObject] = []
    for relation in ordered:
        relation_type = normalized_relation_type(relation)
        driven_id = driven_object_id(relation)
        relation_key = str(relation.id) if relation.id is not None else None
        # Only consider relations where THIS placement drives something else; otherwise
        # solving could move the placement we just edited (causing oscillation/snap-back).
        # Exception: when the placement is itself the driven object, we still want to
        # re-pin it (e.g. table → DBR), but only on the very first pass.
        if str(placement.id) != driver_object_id(relation) and str(placement.id) != driven_id:
            continue
        # If we already solved this exact relation during this cascade run, skip
        # it. The recursion can revisit the same relation when iterating from a
        # downstream placement; without this guard the outer loop would mark
        # the relation as "controlled by higher priority" and overwrite the
        # successful state from the recursion.
        if relation_key is not None and relation_key in solved_relations:
            continue
        if relation_type in POSITION_RELATIONS and driven_id in controlled_positions:
            mark_relation(relation, False, "Driven object position is already controlled by a higher priority relation.")
            continue
        solved = await solve_relation(session, relation)
        if relation_key is not None:
            solved_relations.add(relation_key)
        if solved is not None:
            if relation.solved and relation_type in POSITION_RELATIONS:
                controlled_positions.add(driven_id)
            if solved.id != placement.id:
                changed.append(solved)
                # Transitive cascade: propagate the move further down the chain
                # so grand-children, great-grand-children, etc. all follow.
                key = str(solved.id)
                if key not in visited:
                    visited.add(key)
                    deeper = await _solve_relations_for(
                        session, solved, visited, controlled_positions, solved_relations
                    )
                    changed.extend(deeper)
        elif relation.solved and relation_type in POSITION_RELATIONS:
            controlled_positions.add(driven_id)
    return changed


async def apply_relations_for_object(session: AsyncSession, placement: SceneObject) -> list[SceneObject]:
    visited: set[str] = {str(placement.id)}
    controlled_positions: set[str] = set()
    solved_relations: set[str] = set()
    return await _solve_relations_for(
        session, placement, visited, controlled_positions, solved_relations
    )
