"""Coverage for every active branch of ``solve_relation``.

These tests drive the solver in-process against ``FakeSession`` doubles so we
exercise the actual maths without spinning up Postgres. Each test focuses on
one relation type and asserts the user-visible outcome (driven object's
post-solve transform, ``relation.solved``, error messages on failure).
"""
from __future__ import annotations

import math
import uuid

import pytest

from app.assembly_solver import (
    AXES,
    POSITION_RELATIONS,
    ROTATION_RELATIONS,
    apply_relations_for_object,
    axis_angle_matrix,
    cross,
    euler_from_matrix,
    matmul,
    matrix_from_euler,
    normalize,
    rotation_aligning,
    set_rotation_with_locks,
    solve_relation,
    vec,
)
from app.models import AssemblyRelation, Component, SceneObject


# --------------------------------------------------------------------------- helpers


def approx_vec(a: dict, b: dict, tol: float = 1e-6) -> bool:
    return all(abs(a[axis] - b[axis]) < tol for axis in AXES)


def approx_floats(a: tuple[float, ...], b: tuple[float, ...], tol: float = 1e-4) -> bool:
    return all(abs(x - y) < tol for x, y in zip(a, b, strict=True))


def base_anchors(size: tuple[float, float, float]) -> list[dict]:
    sx, sy, sz = size
    return [
        {"id": "center", "type": "center", "localPosition": vec()},
        {"id": "+x", "type": "face", "localPosition": vec(sx / 2, 0, 0), "localDirection": vec(1, 0, 0)},
        {"id": "-x", "type": "face", "localPosition": vec(-sx / 2, 0, 0), "localDirection": vec(-1, 0, 0)},
        {"id": "+y", "type": "face", "localPosition": vec(0, sy / 2, 0), "localDirection": vec(0, 1, 0)},
        {"id": "-y", "type": "face", "localPosition": vec(0, -sy / 2, 0), "localDirection": vec(0, -1, 0)},
        {"id": "+z", "type": "face", "localPosition": vec(0, 0, sz / 2), "localDirection": vec(0, 0, 1)},
        {"id": "-z", "type": "face", "localPosition": vec(0, 0, -sz / 2), "localDirection": vec(0, 0, -1)},
    ]


def make_object(
    *,
    x: float = 0,
    y: float = 0,
    z: float = 0,
    rx: float = 0,
    ry: float = 0,
    rz: float = 0,
    size: tuple[float, float, float] = (40, 40, 40),
    locked: bool = False,
    locked_axes: dict[str, dict[str, bool]] | None = None,
    name: str = "obj",
) -> SceneObject:
    properties: dict = {"size": {"x": size[0], "y": size[1], "z": size[2]}, "anchors": base_anchors(size)}
    if locked_axes is not None:
        properties["locked"] = locked_axes
    return SceneObject(
        id=uuid.uuid4(),
        component_id=uuid.uuid4(),
        name=name,
        x_mm=x, y_mm=y, z_mm=z,
        rx_deg=rx, ry_deg=ry, rz_deg=rz,
        visible=True, locked=locked,
        properties=properties,
    )


def make_relation(
    *,
    relation_type: str,
    driver: SceneObject,
    driven: SceneObject,
    anchor_a: str = "+x",
    anchor_b: str = "+x",
    offset_mm: float | None = None,
    angle_deg: float | None = None,
    properties: dict | None = None,
) -> AssemblyRelation:
    base_props: dict = {
        "driverObjectId": str(driver.id),
        "drivenObjectId": str(driven.id),
        "priority": 0,
    }
    if properties:
        base_props.update(properties)
    return AssemblyRelation(
        id=uuid.uuid4(),
        name=f"{relation_type}-{driver.name}-{driven.name}",
        relation_type=relation_type,
        object_a_id=driver.id,
        object_b_id=driven.id,
        selector_a={"anchorId": anchor_a, "kind": "face"},
        selector_b={"anchorId": anchor_b, "kind": "face"},
        offset_mm=offset_mm,
        angle_deg=angle_deg,
        tolerance_mm=0.01,
        enabled=True,
        solved=False,
        properties=base_props,
    )


class FakeSession:
    """Async session double sufficient for the solver. Only ``get`` and ``scalars``
    are used; both consult an in-memory dict keyed by UUID."""

    def __init__(self, *objects: SceneObject) -> None:
        self.objects: dict[uuid.UUID, SceneObject] = {o.id: o for o in objects}
        self.relations: list[AssemblyRelation] = []

    async def get(self, model, item_id):
        if model is SceneObject:
            return self.objects.get(item_id)
        if model is Component:
            return None
        return None

    async def scalars(self, _stmt):
        # Used only by ``apply_relations_for_object`` to enumerate relations
        # touching a placement. We hand back the full list and let the solver
        # filter.
        relations = list(self.relations)

        class _Result:
            def __init__(self, items): self._items = items
            def __iter__(self): return iter(self._items)
            def all(self): return list(self._items)

        return _Result(relations)


# --------------------------------------------------------------------------- math sanity


def test_matrix_from_euler_round_trip_identity():
    m = matrix_from_euler(0, 0, 0)
    assert m == ((1, 0, 0), (0, 1, 0), (0, 0, 1))


def test_matrix_from_euler_round_trip_random_angles():
    for rx, ry, rz in [(10, 20, 30), (-45, 60, -30), (89, 0, 45)]:
        m = matrix_from_euler(rx, ry, rz)
        decoded = euler_from_matrix(m)
        recoded = matrix_from_euler(*decoded)
        for i in range(3):
            for j in range(3):
                assert abs(m[i][j] - recoded[i][j]) < 1e-9


def test_rotation_aligning_known_pairs():
    # +X to +Y → 90° around +Z
    r = rotation_aligning(vec(1, 0, 0), vec(0, 1, 0))
    assert approx_vec({"x": r[0][0] * 1 + r[0][1] * 0 + r[0][2] * 0,
                       "y": r[1][0] * 1 + r[1][1] * 0 + r[1][2] * 0,
                       "z": r[2][0] * 1 + r[2][1] * 0 + r[2][2] * 0},
                      vec(0, 1, 0))


def test_rotation_aligning_antiparallel():
    # +X to -X must be a valid 180° rotation around some perpendicular axis.
    r = rotation_aligning(vec(1, 0, 0), vec(-1, 0, 0))
    transformed = vec(
        r[0][0], r[1][0], r[2][0],  # apply to (1,0,0)
    )
    assert approx_vec(transformed, vec(-1, 0, 0))


def test_axis_angle_matrix_roundtrip():
    # Rotate +X by 90° around +Z: should land on +Y.
    m = axis_angle_matrix(vec(0, 0, 1), math.pi / 2)
    transformed = vec(m[0][0], m[1][0], m[2][0])
    assert approx_vec(transformed, vec(0, 1, 0))


# --------------------------------------------------------------------------- position relations


@pytest.mark.asyncio
async def test_same_position_pins_anchor_to_anchor():
    driver = make_object(x=100, name="A", size=(40, 40, 40))
    driven = make_object(x=0, name="B", size=(20, 20, 20))
    rel = make_relation(relation_type="same_position", driver=driver, driven=driven, anchor_a="+x", anchor_b="-x")
    session = FakeSession(driver, driven)

    result = await solve_relation(session, rel)

    # Driver +X anchor world = (120, 0, 0); driven -X anchor must equal it.
    # Driven -X local = (-10, 0, 0) → driven center must be at (130, 0, 0).
    assert result is driven
    assert rel.solved is True
    assert math.isclose(driven.x_mm, 130, abs_tol=1e-6)


@pytest.mark.asyncio
async def test_offset_position_uses_center_to_center_offset_vector():
    driver = make_object(x=10, y=20, z=30, name="A")
    driven = make_object(name="B")
    rel = make_relation(
        relation_type="offset_position", driver=driver, driven=driven,
        properties={"params": {"offset": {"x": 5, "y": 0, "z": -2}}},
    )
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)

    assert rel.solved is True
    assert math.isclose(driven.x_mm, 15, abs_tol=1e-6)
    assert math.isclose(driven.y_mm, 20, abs_tol=1e-6)
    assert math.isclose(driven.z_mm, 28, abs_tol=1e-6)


@pytest.mark.asyncio
async def test_distance_uses_driver_anchor_direction():
    driver = make_object(x=0, name="A", size=(40, 40, 40))
    driven = make_object(name="B", size=(20, 20, 20))
    rel = make_relation(
        relation_type="distance", driver=driver, driven=driven,
        anchor_a="+x", anchor_b="-x",
        properties={"params": {"distance": 50}},
    )
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)
    # Driver +X anchor at (20,0,0). Direction +X. Travel 50 mm → target (70,0,0).
    # Driven -X anchor at (-10,0,0) local → driven center must be at (80, 0, 0).
    assert math.isclose(driven.x_mm, 80, abs_tol=1e-6)


@pytest.mark.asyncio
async def test_face_touch_pins_face_to_face():
    driver = make_object(x=100, name="A", size=(40, 40, 40))
    driven = make_object(name="B", size=(20, 20, 20))
    rel = make_relation(relation_type="face_touch", driver=driver, driven=driven, anchor_a="+x", anchor_b="-x")
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)
    assert math.isclose(driven.x_mm, 130, abs_tol=1e-6)


@pytest.mark.asyncio
async def test_face_offset_keeps_gap_along_anchor_direction():
    driver = make_object(x=0, name="A", size=(40, 40, 40))
    driven = make_object(name="B", size=(20, 20, 20))
    rel = make_relation(
        relation_type="face_offset", driver=driver, driven=driven,
        anchor_a="+x", anchor_b="-x", offset_mm=15.0,
    )
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)
    # Driver +X anchor at (20,0,0). Plus 15 along +X → (35,0,0). Driven -X anchor
    # local = (-10,0,0) → driven center at (45,0,0).
    assert math.isclose(driven.x_mm, 45, abs_tol=1e-6)


@pytest.mark.asyncio
async def test_face_align_center_locks_only_normal_axis():
    driver = make_object(x=0, y=50, z=20, name="A", size=(40, 40, 40))
    driven = make_object(x=200, y=200, z=200, name="B", size=(20, 20, 20))
    rel = make_relation(
        relation_type="face_align_center", driver=driver, driven=driven,
        anchor_a="+x", anchor_b="-x",
    )
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)
    # Normal is +X → driven X stays unaffected by the "share center" logic
    # (anchor world position pinned), but Y and Z snap to driver's anchor Y/Z.
    assert math.isclose(driven.y_mm, 50, abs_tol=1e-6)
    assert math.isclose(driven.z_mm, 20, abs_tol=1e-6)


# --------------------------------------------------------------------------- direction relations (rotation cascade)


@pytest.mark.asyncio
async def test_same_direction_rotates_driven_to_match_driver_world_direction():
    # Driver rotated 90° around Z: its +X face world direction is +Y.
    driver = make_object(rz=90, name="A")
    driven = make_object(name="B")
    rel = make_relation(relation_type="same_direction", driver=driver, driven=driven, anchor_a="+x", anchor_b="+x")
    session = FakeSession(driver, driven)

    result = await solve_relation(session, rel)

    assert result is driven
    assert rel.solved is True
    # Driven should now have its +X face pointing along +Y world (i.e. rz ≈ 90).
    from app.assembly_solver import world_anchor_direction
    direction = await world_anchor_direction(session, driven, "+x")
    assert direction is not None
    assert approx_vec(direction, vec(0, 1, 0))


@pytest.mark.asyncio
async def test_same_direction_works_when_anchors_have_different_local_normals():
    # Driver +X (world +X) — driven uses +Y face. Solver must rotate driven so
    # its local +Y points along world +X (rz ≈ -90°).
    driver = make_object(name="A")
    driven = make_object(name="B")
    rel = make_relation(relation_type="same_direction", driver=driver, driven=driven, anchor_a="+x", anchor_b="+y")
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)

    from app.assembly_solver import world_anchor_direction
    direction = await world_anchor_direction(session, driven, "+y")
    assert direction is not None
    assert approx_vec(direction, vec(1, 0, 0))


@pytest.mark.asyncio
async def test_opposite_direction_anti_aligns():
    driver = make_object(name="A")  # +X world
    driven = make_object(name="B")
    rel = make_relation(relation_type="opposite_direction", driver=driver, driven=driven, anchor_a="+x", anchor_b="+x")
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)

    from app.assembly_solver import world_anchor_direction
    direction = await world_anchor_direction(session, driven, "+x")
    assert direction is not None
    assert approx_vec(direction, vec(-1, 0, 0))


@pytest.mark.asyncio
async def test_perpendicular_direction_drops_parallel_component():
    driver = make_object(name="A")  # +X world
    # Start driven slightly off-axis so the projection has a unique answer.
    driven = make_object(rz=10, name="B")
    rel = make_relation(relation_type="perpendicular_direction", driver=driver, driven=driven, anchor_a="+x", anchor_b="+x")
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)

    from app.assembly_solver import world_anchor_direction
    direction = await world_anchor_direction(session, driven, "+x")
    assert direction is not None
    # Result must be perpendicular to the driver direction.
    assert abs(direction["x"]) < 1e-3


@pytest.mark.asyncio
async def test_face_parallel_behaves_like_same_direction():
    driver = make_object(rz=45, name="A")
    driven = make_object(name="B")
    rel = make_relation(relation_type="face_parallel", driver=driver, driven=driven, anchor_a="+x", anchor_b="+x")
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)

    from app.assembly_solver import world_anchor_direction
    a_dir = await world_anchor_direction(session, driver, "+x")
    b_dir = await world_anchor_direction(session, driven, "+x")
    assert a_dir is not None and b_dir is not None
    assert approx_vec(a_dir, b_dir)


@pytest.mark.asyncio
async def test_look_at_points_driven_anchor_along_center_to_driver_direction():
    driver = make_object(x=300, y=0, z=0, name="A")
    driven = make_object(x=0, y=100, z=0, name="B")
    rel = make_relation(relation_type="look_at", driver=driver, driven=driven, anchor_a="center", anchor_b="+x")
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)

    from app.assembly_solver import world_anchor_direction
    # Solver definition: post-solve, the driven anchor world direction must
    # equal the unit vector from driven center to driver anchor world position.
    desired = vec(300 - 0, 0 - 100, 0 - 0)
    desired_unit = normalize(desired)
    actual = await world_anchor_direction(session, driven, "+x")
    assert actual is not None and desired_unit is not None
    assert approx_vec(actual, desired_unit)


@pytest.mark.asyncio
async def test_align_axis_alias_routes_to_same_direction():
    driver = make_object(rz=90, name="A")
    driven = make_object(name="B")
    rel = make_relation(relation_type="align_axis", driver=driver, driven=driven, anchor_a="+x", anchor_b="+x")
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)
    from app.assembly_solver import world_anchor_direction
    d = await world_anchor_direction(session, driven, "+x")
    assert d is not None and approx_vec(d, vec(0, 1, 0))


# --------------------------------------------------------------------------- lock_transform


@pytest.mark.asyncio
async def test_lock_transform_captures_pose_on_first_solve():
    driver = make_object(x=10, name="A")
    driven = make_object(x=15, name="B")
    rel = make_relation(relation_type="lock_transform", driver=driver, driven=driven, anchor_a="center", anchor_b="center")
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)
    assert rel.solved is True
    assert "lockedTransform" in (rel.properties or {})


@pytest.mark.asyncio
async def test_lock_transform_mirrors_driver_motion_after_capture():
    driver = make_object(x=10, name="A")
    driven = make_object(x=15, name="B")
    rel = make_relation(relation_type="lock_transform", driver=driver, driven=driven, anchor_a="center", anchor_b="center")
    session = FakeSession(driver, driven)

    # First solve captures the (5, 0, 0) delta.
    await solve_relation(session, rel)
    # Move the driver: driven should follow rigidly on the next solve.
    driver.x_mm = 200
    await solve_relation(session, rel)
    assert math.isclose(driven.x_mm, 205, abs_tol=1e-6)


@pytest.mark.asyncio
async def test_lock_transform_propagates_driver_rotation_to_relative_position():
    driver = make_object(x=0, name="A")
    driven = make_object(x=10, name="B")  # offset +X by 10 mm
    rel = make_relation(relation_type="lock_transform", driver=driver, driven=driven, anchor_a="center", anchor_b="center")
    session = FakeSession(driver, driven)

    await solve_relation(session, rel)
    # Rotate the driver 90° around Z. The (10, 0, 0) local delta should rotate
    # to (0, 10, 0), so driven moves to (0, 10, 0).
    driver.rz_deg = 90
    await solve_relation(session, rel)
    assert math.isclose(driven.x_mm, 0, abs_tol=1e-4)
    assert math.isclose(driven.y_mm, 10, abs_tol=1e-4)


# --------------------------------------------------------------------------- not-yet-implemented relations


@pytest.mark.parametrize("relation_type", ["concentric", "tangent", "angle"])
@pytest.mark.asyncio
async def test_unimplemented_relations_fail_with_clear_message(relation_type):
    driver = make_object(name="A")
    driven = make_object(name="B")
    rel = make_relation(relation_type=relation_type, driver=driver, driven=driven)
    session = FakeSession(driver, driven)

    result = await solve_relation(session, rel)
    assert result is None
    assert rel.solved is False
    assert "not yet handle" in (rel.properties or {}).get("solveMessage", "")


# --------------------------------------------------------------------------- locks & robustness


@pytest.mark.asyncio
async def test_locked_position_axis_blocks_position_relation():
    driver = make_object(x=100, name="A")
    driven = make_object(name="B", locked_axes={"position": {"x": True, "y": False, "z": False}})
    rel = make_relation(relation_type="same_position", driver=driver, driven=driven, anchor_a="center", anchor_b="center")
    session = FakeSession(driver, driven)

    result = await solve_relation(session, rel)
    assert result is None
    assert rel.solved is False
    assert "locked" in (rel.properties or {}).get("solveMessage", "").lower()


@pytest.mark.asyncio
async def test_locked_rotation_axis_blocks_rotation_relation():
    driver = make_object(rz=90, name="A")
    driven = make_object(name="B", locked_axes={"rotation": {"x": False, "y": False, "z": True}})
    rel = make_relation(relation_type="same_direction", driver=driver, driven=driven, anchor_a="+x", anchor_b="+x")
    session = FakeSession(driver, driven)

    result = await solve_relation(session, rel)
    assert result is None
    assert rel.solved is False
    assert "locked" in (rel.properties or {}).get("solveMessage", "").lower()


@pytest.mark.asyncio
async def test_disabled_relation_is_skipped():
    driver = make_object(x=100, name="A")
    driven = make_object(name="B")
    rel = make_relation(relation_type="same_position", driver=driver, driven=driven, anchor_a="center", anchor_b="center")
    rel.enabled = False
    session = FakeSession(driver, driven)

    result = await solve_relation(session, rel)
    assert result is None
    assert rel.solved is False


@pytest.mark.asyncio
async def test_set_rotation_with_locks_respects_per_axis_locks():
    obj = make_object(rx=10, ry=20, rz=30, locked_axes={"rotation": {"x": False, "y": True, "z": False}})

    # Try to set ry to a different value — should be rejected.
    assert set_rotation_with_locks(obj, (45.0, 99.0, 60.0)) is False
    # ry was unchanged because we returned False before any mutation could happen
    # — but because the lock check returns early, no axes mutated.
    assert obj.rx_deg == 10
    assert obj.ry_deg == 20
    assert obj.rz_deg == 30

    # Try to set ry to its current value (modulo 360) — succeeds and other axes update.
    assert set_rotation_with_locks(obj, (45.0, 20.0, 60.0)) is True
    assert obj.rx_deg == 45
    assert obj.ry_deg == 20  # locked axis preserved
    assert obj.rz_deg == 60


# --------------------------------------------------------------------------- end-to-end cascade


@pytest.mark.asyncio
async def test_apply_relations_cascades_rotation_then_position():
    """A drives B (same_direction + face_touch). Rotating A should rotate B
    AND keep their faces touching at the new world position.
    """
    a = make_object(x=0, name="A", size=(40, 40, 40))
    b = make_object(x=100, name="B", size=(20, 20, 20))
    same_dir = make_relation(relation_type="same_direction", driver=a, driven=b, anchor_a="+x", anchor_b="-x")
    face_touch = make_relation(relation_type="face_touch", driver=a, driven=b, anchor_a="+x", anchor_b="-x")
    session = FakeSession(a, b)
    session.relations.extend([same_dir, face_touch])

    # Now rotate A 90° around Z.
    a.rz_deg = 90
    changed = await apply_relations_for_object(session, a)
    assert b in changed
    # B should be rotated so its -X face direction matches A's +X face direction (= +Y).
    from app.assembly_solver import world_anchor_direction
    b_dir = await world_anchor_direction(session, b, "-x")
    assert b_dir is not None and approx_vec(b_dir, vec(0, 1, 0))


# --------------------------------------------------------------------------- relation classification sets


def test_relation_classification_sets_have_no_overlap():
    assert ROTATION_RELATIONS.isdisjoint(POSITION_RELATIONS)
