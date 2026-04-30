from __future__ import annotations

import math
import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.models import AssemblyRelation, Component, Placement


Vec = dict[str, float]
AXES = ("x", "y", "z")
POSITION_FIELDS = {"x": "x_mm", "y": "y_mm", "z": "z_mm"}
ROTATION_FIELDS = {"x": "rx_deg", "y": "ry_deg", "z": "rz_deg"}
POSITION_RELATIONS = {"same_position", "offset_position", "distance", "face_touch", "face_offset", "face_align_center"}
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


def placement_position(placement: Placement) -> Vec:
    return vec(placement.x_mm, placement.y_mm, placement.z_mm)


def placement_rotation(placement: Placement) -> tuple[float, float, float]:
    return (
        float(placement.rx_deg or 0.0),
        float(placement.ry_deg or 0.0),
        float(placement.rz_deg or 0.0),
    )


def placement_size(placement: Placement, component: Component | None) -> Vec:
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


def standard_anchor(anchor_id: str, size: Vec) -> dict[str, object] | None:
    half = {axis: size[axis] / 2 for axis in AXES}
    anchors: dict[str, dict[str, object]] = {
        "center": {"id": "center", "name": "Center", "type": "center", "localPosition": vec()},
        "+x": {"id": "+x", "name": "+X face", "type": "face", "localPosition": vec(half["x"], 0, 0), "localDirection": vec(1, 0, 0)},
        "-x": {"id": "-x", "name": "-X face", "type": "face", "localPosition": vec(-half["x"], 0, 0), "localDirection": vec(-1, 0, 0)},
        "+y": {"id": "+y", "name": "+Y face", "type": "face", "localPosition": vec(0, half["y"], 0), "localDirection": vec(0, 1, 0)},
        "-y": {"id": "-y", "name": "-Y face", "type": "face", "localPosition": vec(0, -half["y"], 0), "localDirection": vec(0, -1, 0)},
        "+z": {"id": "+z", "name": "+Z face", "type": "face", "localPosition": vec(0, 0, half["z"]), "localDirection": vec(0, 0, 1)},
        "-z": {"id": "-z", "name": "-Z face", "type": "face", "localPosition": vec(0, 0, -half["z"]), "localDirection": vec(0, 0, -1)},
    }
    normalized_id = normalize_anchor_id(anchor_id)
    return anchors.get(normalized_id)

async def component_for(session: AsyncSession, placement: Placement) -> Component | None:
    return await session.get(Component, placement.component_id)


async def anchor_for(session: AsyncSession, placement: Placement, anchor_id: str | None) -> dict[str, object]:
    properties = placement.properties if isinstance(placement.properties, dict) else {}
    anchor_id = normalize_anchor_id(anchor_id)
    anchors = properties.get("anchors")
    if isinstance(anchors, list):
        for anchor in anchors:
            if isinstance(anchor, dict) and normalize_anchor_id(anchor.get("id")) == anchor_id:
                return anchor

    component = await component_for(session, placement)
    return standard_anchor(anchor_id, placement_size(placement, component)) or standard_anchor("center", vec(100, 100, 100))


async def world_anchor_position(session: AsyncSession, placement: Placement, anchor_id: str | None) -> Vec:
    anchor = await anchor_for(session, placement, anchor_id)
    local_position = read_vec(anchor.get("localPosition"))
    rotated = rotate_vec(local_position, *placement_rotation(placement))
    return add(placement_position(placement), rotated)


async def world_anchor_direction(session: AsyncSession, placement: Placement, anchor_id: str | None) -> Vec | None:
    anchor = await anchor_for(session, placement, anchor_id)
    direction = read_vec(anchor.get("localDirection"), fallback=None)
    if not any(direction[axis] for axis in AXES):
        selector_normal = anchor.get("normal")
        if selector_normal is None:
            return None
        direction = read_vec(selector_normal)
    rotated = rotate_vec(direction, *placement_rotation(placement))
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


def lock_state(placement: Placement) -> dict[str, dict[str, bool]]:
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


def set_position_with_locks(placement: Placement, next_position: Vec) -> bool:
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


def mark_relation(relation: AssemblyRelation, solved: bool, message: str | None = None) -> None:
    relation.solved = solved
    properties = relation.properties if isinstance(relation.properties, dict) else {}
    if message:
        properties["solveMessage"] = message
    else:
        properties.pop("solveMessage", None)
    relation.properties = properties


def mark_controlled_by(placement: Placement, relation: AssemblyRelation) -> None:
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


async def solve_relation(session: AsyncSession, relation: AssemblyRelation) -> Placement | None:
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

    driver = await session.get(Placement, driver_pk)
    driven = await session.get(Placement, driven_pk)
    if driver is None or driven is None:
        mark_relation(relation, False, "Relation references a missing object.")
        return None
    if any(lock_state(driven)["position"].values()) and driven.locked:
        mark_relation(relation, False, "Driven object is locked.")
        return None

    relation_type = normalized_relation_type(relation)
    driver_anchor = await world_anchor_position(session, driver, driver_target.get("anchorId"))
    driven_anchor = await world_anchor_position(session, driven, driven_target.get("anchorId"))
    driven_position = placement_position(driven)
    anchor_delta = sub(driven_anchor, driven_position)
    params = relation_params(relation)

    if relation_type in {"same_position", "face_touch"}:
        next_position = sub(driver_anchor, anchor_delta)
    elif relation_type in {"offset_position", "face_offset"}:
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
    elif relation_type in {"same_direction", "opposite_direction", "perpendicular_direction", "face_parallel", "look_at"}:
        direction_a = await world_anchor_direction(session, driver, driver_target.get("anchorId"))
        direction_b = await world_anchor_direction(session, driven, driven_target.get("anchorId"))
        if direction_a is None or direction_b is None:
            mark_relation(relation, False, "Direction relation needs anchors with localDirection.")
            return None
        alignment = dot(direction_a, direction_b)
        if relation_type in {"same_direction", "face_parallel"}:
            solved = abs(alignment) >= 0.999
        elif relation_type == "opposite_direction":
            solved = alignment <= -0.999
        elif relation_type == "perpendicular_direction":
            solved = abs(alignment) <= 0.001
        else:
            solved = True
        mark_relation(relation, solved, None if solved else "Direction relation is not satisfied yet.")
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


async def apply_relations_for_object(session: AsyncSession, placement: Placement) -> list[Placement]:
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
    ordered = sorted(list(relations), key=relation_priority, reverse=True)
    changed: list[Placement] = []
    controlled_positions: set[str] = set()
    for relation in ordered:
        relation_type = normalized_relation_type(relation)
        driven_id = driven_object_id(relation)
        if relation_type in POSITION_RELATIONS and driven_id in controlled_positions:
            mark_relation(relation, False, "Driven object position is already controlled by a higher priority relation.")
            continue
        solved = await solve_relation(session, relation)
        if solved is not None and solved.id != placement.id:
            changed.append(solved)
        if relation.solved and relation_type in POSITION_RELATIONS:
            controlled_positions.add(driven_id)
    return changed
